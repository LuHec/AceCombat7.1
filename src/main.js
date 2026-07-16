// 主循环：渲染管线（Bloom）、游戏状态机、任务脚本、输入、菜单
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { World, cloudDensityAt } from './world.js';
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
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.42, 0.6, 0.85);
composer.addPass(bloom);
composer.addPass(new OutputPass());

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// ============ 系统 ============
const world = new World(scene);
const audio = new GameAudio();
const weather = new Weather(scene, world, audio);
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
    if (e.code === 'KeyV' && G.player) G.player.camMode = (G.player.camMode + 1) % 2;
    if (e.code === 'KeyP') togglePause();
    if (e.code >= 'Digit1' && e.code <= 'Digit4') {
      weather.setState(e.code.charCodeAt(5) - 49);
      addFeed('天气变更 → ' + WEATHER_STATES[weather.stateIdx].key);
    }
  } else if (G.mode === 'end') {
    if (e.code === 'KeyR') restart(true);
    if (e.code === 'KeyH') restart(false);
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
  audio.setMusicLevel(2);
  G.combat = new CombatManager(scene, world, G.player, audio, {
    onKill: (msg) => addFeed(msg),
    onPhase: (n) => {
      if (n === 2) {
        addFeed('⚠ 侦测到 ARSENAL BIRD 进入战斗空域');
        addFeed('摧毁军械巨鸟！');
        audio.setMusicLevel(3);
      }
    },
    onPlayerHit: () => addFeed('被导弹命中！'),
    onWin: () => showEnd(true),
    onLose: () => showEnd(false),
  });
  G.time = 0;
  G.feed.length = 0;
  addFeed('任务开始：夺回宇宙电梯空域');
  addFeed('击坠所有 UAV');
  const w0 = parseInt(params.get('weather') || '-1');
  if (w0 >= 0 && w0 < 4) weather.setState(w0);
  if (params.has('phase2')) G.combat.debugForcePhase2();
}

function showEnd(win) {
  if (G.endShown) return;
  G.endShown = true;
  G.mode = 'end';
  audio.setMusicLevel(win ? 3 : 1);
  const t = el('end-title');
  t.textContent = win ? 'MISSION ACCOMPLISHED' : 'YOU WERE SHOT DOWN';
  t.classList.toggle('fail', !win);
  const mt = Math.floor(G.time / 60), st = Math.floor(G.time % 60);
  el('end-stats').innerHTML =
    `座机 ${G.player.def.name}<br>击坠数 ${G.combat.killCount}　 SCORE ${G.combat.score}<br>任务时间 ${mt}:${String(st).padStart(2, '0')}`;
  el('menu-end').classList.remove('hidden');
}

function restart(sameAircraft) {
  if (sameAircraft && G.player) sessionStorage.setItem('ac_auto', G.player.def.id);
  else sessionStorage.removeItem('ac_auto');
  location.reload();
}

function togglePause() {
  G.paused = !G.paused;
  el('pause').classList.toggle('hidden', !G.paused);
}

el('btn-retry').addEventListener('click', () => restart(true));
el('btn-hangar').addEventListener('click', () => restart(false));
el('menu-title').addEventListener('click', () => { if (G.mode === 'title') showSelect(); });

// 自动开局（测试 / 快速重开）
const autoAc = params.get('auto') || sessionStorage.getItem('ac_auto');
if (autoAc) {
  sessionStorage.removeItem('ac_auto');
  startGame(autoAc);
}

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

    // 测试钩子：伴飞巨鸟 + 自动开火（?birdcam=1）
    if (BIRDCAM && G.combat.bird.alive) {
      const b = G.combat.bird;
      _wV.set(-Math.sin(b.angle), 0, Math.cos(b.angle));
      p.pos.copy(b.pos).addScaledVector(_wV, -330);
      p.pos.y = b.pos.y + 25;
      p.group.quaternion.setFromAxisAngle(_wUp, Math.atan2(_wV.x, _wV.z));
      p.speed = 90;
      if (Math.floor(elapsed * 1.5) !== Math.floor((elapsed - dt) * 1.5)) keys.Space = true;
    }

    // 穿云检测（体积云密度场）
    const inside = clamp(cloudDensityAt(camera.position.x, camera.position.y, camera.position.z, elapsed, weather.coverage) * 2.0, 0, 1);
    G.inCloud = lerp(G.inCloud, inside, Math.min(1, dt * 5));
    cloudfade.style.opacity = (G.inCloud * 0.55).toFixed(2);

    // 受击红晕
    const hpF = p.hp / p.maxHp;
    vignette.style.opacity = clamp((1 - hpF) * 0.85 + (p.shake > 0.6 ? 0.35 : 0), 0, 1).toFixed(2);

    // 任务目标文本
    if (G.combat.phase === 1) {
      G.mission = `MISSION — 击坠所有 UAV（剩余 ${G.combat.countDrones()}）`;
    } else if (G.combat.bird.alive) {
      G.mission = 'MISSION — 摧毁 ARSENAL BIRD「军械巨鸟」';
    } else {
      G.mission = '';
    }

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
  if (params.has('nocomposer')) renderer.render(scene, camera);
  else composer.render();
});

// 测试快进：?ff=秒数，固定步长推进模拟
const ff = parseFloat(params.get('ff') || '0');
if (ff > 0) {
  const n = Math.min(Math.floor(ff * 30), 3600);
  for (let i = 0; i < n; i++) step(1 / 30);
}
