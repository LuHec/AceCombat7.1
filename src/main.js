// 主循环：渲染管线（Bloom）、游戏状态机、任务脚本、输入、菜单
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { World, cloudDensityAt, CLOUD_GLSL, SUN_DIR, SILO_POS } from './world.js';
import { Weather, WEATHER_STATES } from './weather.js';
import { Player } from './flight.js';
import { CombatManager } from './combat.js';
import { HUD } from './hud.js';
import { GameAudio } from './audio.js';
import { AIRCRAFT } from './models.js';
import { clamp, lerp } from './utils.js';

// ============ 渲染器 ============
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 3, 70000);
camera.position.set(6800, 570, 3720);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

// ---- 深度预渲染（体积云遮挡合成 + 体积光天空掩码）----
function makeDepthRT(w, h) {
  const rt = new THREE.WebGLRenderTarget(w, h);
  rt.depthTexture = new THREE.DepthTexture(w, h);
  return rt;
}
let depthRT = makeDepthRT(window.innerWidth, window.innerHeight);
const depthOverride = new THREE.MeshDepthMaterial();

// ---- 体积云 Pass：逐像素深度截断的 Raymarch（散射/透射/自阴影）----
const cloudPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: depthRT.depthTexture },
    camPos: { value: new THREE.Vector3() },
    invView: { value: new THREE.Matrix3() },
    projInfo: { value: new THREE.Vector2(1, 1) },
    zInfo: { value: new THREE.Vector2(3, 70000) },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse, tDepth, cloudMap;
    uniform vec3 camPos;
    uniform mat3 invView;
    uniform vec2 projInfo, zInfo;
    uniform vec3 sunDir, sunColor, fogColor;
    uniform float flash, storm, time, coverage, fogDensity;
    uniform vec4 cloudForm;
    varying vec2 vUv;
    ${CLOUD_GLSL}
    float hg(float c, float g){ float g2 = g * g; return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5); }
    float ign(vec2 px){ return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }
    void main(){
      vec4 base = texture2D(tDiffuse, vUv);
      float depth = texture2D(tDepth, vUv).x;
      vec2 ndc = vUv * 2.0 - 1.0;
      vec3 rdV = normalize(vec3(ndc.x * projInfo.x, ndc.y * projInfo.y, -1.0));
      float viewZ = (zInfo.x * zInfo.y) / ((zInfo.y - zInfo.x) * depth - zInfo.y);
      float tScene = depth > 0.99995 ? 42000.0 : clamp(viewZ / rdV.z, 0.0, 42000.0);
      vec3 rd = normalize(invView * rdV);
      vec3 ro = camPos;
      bool inSlab = ro.y > 480.0 && ro.y < 4200.0;
      float tA = (480.0 - ro.y) / rd.y;
      float tB = (4200.0 - ro.y) / rd.y;
      float t0 = min(tA, tB), t1 = max(tA, tB);
      if (inSlab) t0 = 0.0;
      bool skip = !inSlab && abs(rd.y) < 0.0004;
      t0 = max(t0, 0.0);
      t1 = min(t1, 42000.0);
      t1 = min(t1, tScene);
      if (rd.y < -0.0004){
        float tSea = (0.0 - ro.y) / rd.y;
        if (tSea > 0.0) t1 = min(t1, tSea);
      }
      vec3 col = vec3(0.0);
      float T = 1.0;
      if (!skip && t1 > t0){
        float ct = dot(rd, sunDir);
        float phase = hg(ct, 0.62) * 2.8 + hg(ct, -0.22) * 0.7;   // 双瓣散射相位
        float step0 = clamp((t1 - t0) / 44.0, 120.0, 900.0);
        float t = t0 + ign(gl_FragCoord.xy) * step0;
        float stepL = step0;
        for (int i = 0; i < 56; i++){
          if (t > t1 || T < 0.03) break;
          vec3 p = ro + rd * t;
          float d = cloudField(p);
          if (d > 0.01){
            // 自阴影：沿太阳方向 5 点采样透射率
            float dl = cloudField(p + sunDir * 80.0)
                     + cloudField(p + sunDir * 200.0)
                     + cloudField(p + sunDir * 380.0)
                     + cloudField(p + sunDir * 620.0)
                     + cloudField(p + sunDir * 900.0);
            float lt = exp(-dl * 0.55);          // 直接透射
            float lt2 = exp(-dl * 0.16) * 0.55;  // 多次散射补光
            float h = clamp((p.y - 480.0) / 3720.0, 0.0, 1.0);
            vec3 amb = mix(vec3(0.32, 0.35, 0.47), vec3(0.98, 0.94, 0.99), h);
            amb = mix(amb, amb * vec3(1.0, 0.86, 0.72), 0.22);
            amb *= (1.0 - storm * 0.55);
            amb *= (1.0 - 0.42 * clamp(d, 0.0, 1.0));
            float powder = 1.0 - exp(-d * 5.0);
            vec3 cc = amb + sunColor * (lt * phase * 1.55 + lt2 * 0.9) * powder * (1.0 - storm * 0.65);
            cc += vec3(0.85, 0.9, 1.0) * flash * 1.7;
            float fogF = 1.0 - exp(-fogDensity * fogDensity * t * t);
            cc = mix(cc, fogColor, fogF);
            float a = 1.0 - exp(-d * stepL * 0.055);
            col += cc * a * T;
            T *= 1.0 - a;
          }
          t += stepL;
          stepL *= 1.11;
        }
      }
      gl_FragColor = vec4(mix(base.rgb, col, 1.0 - T), 1.0);
    }`,
});
cloudPass.uniforms.tDepth.value = depthRT.depthTexture;
composer.addPass(cloudPass);

// ---- 体积光 Pass（God Rays：向太阳屏幕位置的径向散射，用深度掩天空）----
const godRayPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: depthRT.depthTexture },
    sunScreen: { value: new THREE.Vector2(0.5, 0.5) },
    sunVis: { value: 0 },
    sunTint: { value: new THREE.Color(0xffd9a8) },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse, tDepth;
    uniform vec2 sunScreen;
    uniform float sunVis;
    uniform vec3 sunTint;
    varying vec2 vUv;
    void main(){
      vec4 base = texture2D(tDiffuse, vUv);
      if (sunVis < 0.01){ gl_FragColor = base; return; }
      vec2 delta = (sunScreen - vUv) * 0.55 / 52.0;
      vec2 uv = vUv;
      float illum = 1.0;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 52; i++){
        uv += delta;
        float sky = step(0.9995, texture2D(tDepth, uv).x);
        vec3 s = max(texture2D(tDiffuse, uv).rgb * sky - vec3(0.42), vec3(0.0));
        acc += s * illum;
        illum *= 0.952;
      }
      gl_FragColor = vec4(base.rgb + acc * (1.0 / 52.0) * sunVis * 0.85 * sunTint, 1.0);
    }`,
});
godRayPass.uniforms.tDepth.value = depthRT.depthTexture;
composer.addPass(godRayPass);

const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.42, 0.6, 0.85);
composer.addPass(bloom);
composer.addPass(new OutputPass());

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  depthRT.dispose();
  depthRT = makeDepthRT(window.innerWidth, window.innerHeight);
  cloudPass.uniforms.tDepth.value = depthRT.depthTexture;
  godRayPass.uniforms.tDepth.value = depthRT.depthTexture;
});

// ============ 系统 ============
const world = new World(scene);
const audio = new GameAudio();
const weather = new Weather(scene, world, audio);
// 共享世界 uniforms 到云 Pass
for (const k of ['sunDir', 'sunColor', 'fogColor', 'fogDensity', 'flash', 'storm', 'time', 'coverage', 'cloudForm'])
  cloudPass.uniforms[k] = world.skyUniforms[k];
cloudPass.uniforms.cloudMap = { value: world.cloudMapTex };
const hud = new HUD(document.getElementById('hud'));

const G = {
  mode: 'title',          // title | select | play | end
  player: null,
  combat: null,
  camera,
  weather,
  time: 0,
  feed: [],
  mission: '',
  inCloud: 0,
  paused: false,
  endShown: false,
};
window.__game = G;

// ============ 输入 ============
const keys = {};
const GAME_KEYS = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyF', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight'];
window.addEventListener('keydown', (e) => {
  if (GAME_KEYS.includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  keys[e.code] = true;
  audio.init();

  if (G.mode === 'title' && (e.code === 'Enter' || e.code === 'NumpadEnter')) showSelect();
  else if (G.mode === 'select') {
    if (e.code === 'Digit1') startGame('f16');
    if (e.code === 'Digit2') startGame('f22');
    if (e.code === 'Digit3') startGame('su57');
  } else if (G.mode === 'play') {
    if (e.code === 'KeyV' && G.player) G.player.camMode = (G.player.camMode + 1) % 3;
    if (e.code === 'KeyP') togglePause();
    if (e.code >= 'Digit1' && e.code <= 'Digit4') {
      weather.setState(e.code.charCodeAt(5) - 49);
      addFeed('天气变更 → ' + WEATHER_STATES[weather.stateIdx].key);
    }
  } else if (G.mode === 'end') {
    if (e.code === 'KeyR') restart(true);
    if (e.code === 'KeyH') restart(false);
    if (e.code === 'KeyN' && !el('btn-next').classList.contains('hidden')) nextMission();
  }
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
window.addEventListener('pointerdown', () => audio.init());

// 鼠标指向 + 左键机炮 / 右键导弹
G.mouse = { x: 0, y: 0 };
let mouseGun = false;
window.addEventListener('mousemove', (e) => {
  G.mouse.x = clamp((e.clientX - window.innerWidth / 2) / (window.innerWidth / 2), -1, 1);
  G.mouse.y = clamp((e.clientY - window.innerHeight / 2) / (window.innerHeight / 2), -1, 1);
});
window.addEventListener('mousedown', (e) => {
  audio.init();
  if (G.mode !== 'play') return;
  if (e.button === 0) mouseGun = true;
  if (e.button === 2) keys.Space = true;
});
window.addEventListener('mouseup', (e) => { if (e.button === 0) mouseGun = false; });
window.addEventListener('contextmenu', (e) => { if (G.mode === 'play') e.preventDefault(); });

// 俯仰反转选项（持久化）
const invertChk = document.getElementById('opt-inverty');
invertChk.checked = localStorage.getItem('ac_inverty') === '1';
invertChk.addEventListener('change', () => {
  localStorage.setItem('ac_inverty', invertChk.checked ? '1' : '0');
  if (G.player) G.player.invertY = invertChk.checked;
});

// ============ 菜单 ============
const el = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

function buildCards() {
  const wrap = el('cards');
  let i = 1;
  for (const def of Object.values(AIRCRAFT)) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="key-hint">[${i}]</div>
      <div class="ac-name">${def.name}</div>
      <div class="ac-role">${def.role}</div>
      ${Object.entries(def.stats).map(([k, v]) => `
        <div class="stat"><span class="lbl">${k}</span>
        <span class="bar"><i style="width:${v * 20}%"></i></span></div>`).join('')}
      <div class="ac-msl">MSL × ${def.msl}　耐久 ${def.hp}</div>`;
    card.addEventListener('click', () => startGame(def.id));
    wrap.appendChild(card);
    i++;
  }
}
buildCards();

function showSelect() {
  G.mode = 'select';
  audio.setMusicLevel(1);
  el('menu-title').classList.add('hidden');
  el('menu-select').classList.remove('hidden');
}

function addFeed(msg) {
  G.feed.unshift({ msg, t: 0 });
  if (G.feed.length > 6) G.feed.pop();
}

function startGame(acId) {
  const def = AIRCRAFT[acId] || AIRCRAFT.f22;
  const mission = parseInt(params.get('m') || sessionStorage.getItem('ac_mission') || '1');
  G.missionId = mission;
  G.mode = 'play';
  G.paused = false;
  G.endShown = false;
  el('menu-title').classList.add('hidden');
  el('menu-select').classList.add('hidden');
  el('menu-end').classList.add('hidden');

  if (G.player) {
    // 重新开始：清场
    location.reload();
    return;
  }
  G.player = new Player(scene, def);
  G.player.mouseRef = G.mouse;
  G.player.invertY = invertChk.checked;
  if (params.has('god')) G.player.damage = () => {};   // 测试用无敌
  audio.setMusicLevel(mission === 2 ? 3 : 2);
  G.combat = new CombatManager(scene, world, G.player, audio, {
    onKill: (msg) => addFeed(msg),
    onPhase: (n) => {
      if (n === 2) {
        addFeed('⚠ 侦测到 ARSENAL BIRD 进入战斗空域');
        addFeed('摧毁军械巨鸟！');
        audio.setMusicLevel(3);
      }
    },
    onStage: (s) => {
      if (s === 'reveal') audio.setMusicLevel(4);
      if (s === 'cannon') audio.setMusicLevel(4);
    },
    onPlayerHit: () => addFeed('被导弹命中！'),
    onWin: () => showEnd(true),
    onLose: () => showEnd(false),
  }, mission);
  G.time = 0;
  G.feed.length = 0;
  if (mission === 2) {
    addFeed('任务开始：压制敌方 SAM 防空网');
    addFeed('僚机已加入编队');
  } else {
    addFeed('任务开始：夺回宇宙电梯空域');
    addFeed('击坠所有 UAV');
  }
  const w0 = parseInt(params.get('weather') || '-1');
  if (w0 >= 0 && w0 < 4) weather.setState(w0);
  if (params.has('cam')) G.player.camMode = parseInt(params.get('cam')) % 3;
  if (params.has('phase2')) G.combat.debugForcePhase2();
  // 测试：直达巨炮出场（?silo=1）
  if (params.has('silo') && G.combat.mission === 2) {
    for (const g of G.combat.groundTargets) { g.alive = false; g.group.visible = false; }
    G.player.pos.set(SILO_POS.x + 900, SILO_POS.y + 350, SILO_POS.z + 900);
    G.player.group.lookAt(new THREE.Vector3(SILO_POS.x, SILO_POS.y + 60, SILO_POS.z));
  }
}

function showEnd(win) {
  if (G.endShown) return;
  G.endShown = true;
  G.mode = 'end';
  audio.setMusicLevel(win ? 3 : 1);
  el('btn-next').classList.toggle('hidden', !(win && G.missionId === 1));
  const t = el('end-title');
  t.textContent = win ? 'MISSION ACCOMPLISHED' : 'YOU WERE SHOT DOWN';
  t.classList.toggle('fail', !win);
  const mt = Math.floor(G.time / 60), st = Math.floor(G.time % 60);
  el('end-stats').innerHTML =
    `座机 ${G.player.def.name}<br>击坠数 ${G.combat.killCount}　 SCORE ${G.combat.score}<br>任务时间 ${mt}:${String(st).padStart(2, '0')}`;
  el('menu-end').classList.remove('hidden');
}

function nextMission() {
  sessionStorage.setItem('ac_mission', '2');
  restart(true);
}

function restart(sameAircraft) {
  if (sameAircraft && G.player) sessionStorage.setItem('ac_auto', G.player.def.id);
  else {
    sessionStorage.removeItem('ac_auto');
    sessionStorage.removeItem('ac_mission');
  }
  location.reload();
}

function togglePause() {
  G.paused = !G.paused;
  el('pause').classList.toggle('hidden', !G.paused);
}

el('btn-retry').addEventListener('click', () => restart(true));
el('btn-hangar').addEventListener('click', () => restart(false));
el('btn-next').addEventListener('click', () => nextMission());
el('menu-title').addEventListener('click', () => { if (G.mode === 'title') showSelect(); });

// ============ 覆盖层 ============
const vignette = el('vignette'), cloudfade = el('cloudfade'), flashfx = el('flashfx');

// ============ 主循环 ============
const clock = new THREE.Clock();
let elapsed = 0;
const DEBUG = params.has('debug');
let _dbgT = 0;

const _zeroVel = new THREE.Vector3();
const _wV = new THREE.Vector3();
const _wUp = new THREE.Vector3(0, 1, 0);
const BIRDCAM = params.has('birdcam');
const SILOCAM = params.has('silo');

function step(dt) {
  elapsed += dt;

  // 世界始终更新（菜单背景也生动）
  world.update(dt, elapsed, camera);

  if (G.mode === 'play' || G.mode === 'end') {
    const p = G.player;
    if (G.mode === 'play') G.time += dt;

    p.update(dt, keys, world);
    p.updateCamera(camera, dt, elapsed);
    G.combat.update(dt, keys, keys.KeyF || mouseGun);
    G.combat.effects.update(dt);

    // 测试钩子：环绕地井（?silo=1）
    if (SILOCAM && G.combat.silo) {
      const sp = G.combat.silo.group.position;
      const a = elapsed * 0.22;
      p.pos.set(sp.x + Math.cos(a) * 720, sp.y + 400, sp.z + Math.sin(a) * 720);
      p.group.lookAt(sp.x, sp.y + 40, sp.z);
      p.speed = 160;
      p.hp = p.maxHp;
    }

    // 测试钩子：伴飞巨鸟 + 自动开火（?birdcam=1）
    if (BIRDCAM && G.combat.bird && G.combat.bird.alive) {
      const b = G.combat.bird;
      _wV.set(-Math.sin(b.angle), 0, Math.cos(b.angle));
      p.pos.copy(b.pos).addScaledVector(_wV, -330);
      p.pos.y = b.pos.y + 25;
      p.group.quaternion.setFromAxisAngle(_wUp, Math.atan2(_wV.x, _wV.z));
      p.speed = 90;
      if (Math.floor(elapsed * 1.5) !== Math.floor((elapsed - dt) * 1.5)) keys.Space = true;
    }

    // 穿云检测（体积云密度场）
    const inside = clamp(cloudDensityAt(camera.position.x, camera.position.y, camera.position.z, elapsed, weather.coverage, weather.cloudForm) * 2.0, 0, 1);
    G.inCloud = lerp(G.inCloud, inside, Math.min(1, dt * 5));
    cloudfade.style.opacity = (G.inCloud * 0.55).toFixed(2);

    // 受击红晕
    const hpF = p.hp / p.maxHp;
    vignette.style.opacity = clamp((1 - hpF) * 0.85 + (p.shake > 0.6 ? 0.35 : 0), 0, 1).toFixed(2);

    // 任务目标文本
    G.mission = G.combat.getObjective();

    for (const f of G.feed) f.t += dt;
    while (G.feed.length && G.feed[G.feed.length - 1].t > 5) G.feed.pop();

    // 音频
    audio.update(dt, {
      throttle: p.throttle, ab: p.ab, speed: p.speed,
      rain: weather.rainIntensity * (G.inCloud > 0.3 ? 1 : 0.8),
      lock: G.combat.lock.locked ? 2 : (G.combat.lock.hasCandidate ? 1 : 0),
      alert: G.combat.incomingAlarm,
      muted: !p.alive,
    });

    hud.draw(G, dt);
  } else {
    // 菜单阶段：绕电梯巡航镜头
    const a = elapsed * 0.04;
    camera.position.set(Math.cos(a) * 2600, 700 + Math.sin(elapsed * 0.1) * 120, Math.sin(a) * 2600);
    camera.lookAt(0, 500, 0);
    camera.up.set(0, 1, 0);
    if (Math.abs(camera.fov - 58) > 0.1) { camera.fov = 58; camera.updateProjectionMatrix(); }
  }

  weather.update(dt, elapsed, camera.position, G.player ? G.player.vel : _zeroVel);
  flashfx.style.opacity = (weather.flash * 0.22).toFixed(2);

  if (DEBUG && (elapsed - _dbgT) > 1) {
    _dbgT = elapsed;
    const c = weather.cur;
    el('errlog').textContent = JSON.stringify({
      t: elapsed.toFixed(1), cov: c.cov.toFixed(2), rain: c.rain.toFixed(2), storm: c.storm.toFixed(2),
      fog: c.fog.toFixed(5), state: weather.stateIdx,
      cam: camera.position.toArray().map(v => v.toFixed(0)),
      inCloud: G.inCloud.toFixed(2),
      calls: renderer.info.render.calls, tris: renderer.info.render.triangles,
      lock: G.combat && G.combat.lock.target ? `${G.combat.lock.progress.toFixed(2)}@${(G.combat.lock.target.pos.distanceTo(G.player.pos) / 1000).toFixed(1)}km` : 'none',
      mode: G.mode, err: window.__errors,
    });
  }
}

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!G.paused) step(dt);
  if (params.has('nocomposer')) { renderer.render(scene, camera); return; }
  camera.updateMatrixWorld();

  // 深度预渲染（隐藏天空与雨幕）
  const rainVis = weather.rain.visible;
  world.sky.visible = false;
  weather.rain.visible = false;
  scene.overrideMaterial = depthOverride;
  renderer.setRenderTarget(depthRT);
  renderer.clear();
  renderer.render(scene, camera);
  scene.overrideMaterial = null;
  renderer.setRenderTarget(null);
  world.sky.visible = true;
  weather.rain.visible = rainVis;

  // 云 Pass uniforms
  cloudPass.uniforms.camPos.value.copy(camera.position);
  cloudPass.uniforms.invView.value.setFromMatrix4(camera.matrixWorld);
  const tanH = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  cloudPass.uniforms.projInfo.value.set(tanH * camera.aspect, tanH);

  // 体积光 uniforms（太阳屏幕位置与可见度）
  _sunV.copy(SUN_DIR).multiplyScalar(10000).add(camera.position).project(camera);
  const behind = _sunV.z > 1;
  const sx = _sunV.x * 0.5 + 0.5, sy = _sunV.y * 0.5 + 0.5;
  godRayPass.uniforms.sunScreen.value.set(sx, sy);
  const off = Math.max(Math.abs(sx - 0.5), Math.abs(sy - 0.5)) * 2;
  godRayPass.uniforms.sunVis.value = behind ? 0 : clamp(1.3 - off, 0, 1) * (1 - weather.cur.storm * 0.4);

  composer.render();
});
const _sunV = new THREE.Vector3();

// 自动开局（测试 / 快速重开）——置于模块末尾，避免 TDZ
const autoAc = params.get('auto') || sessionStorage.getItem('ac_auto');
if (autoAc) {
  sessionStorage.removeItem('ac_auto');
  startGame(autoAc);
}
// 测试快进：?ff=秒数，固定步长推进模拟
const ff = parseFloat(params.get('ff') || '0');
if (ff > 0) {
  const n = Math.min(Math.floor(ff * 30), 3600);
  for (let i = 0; i < n; i++) step(1 / 30);
}
