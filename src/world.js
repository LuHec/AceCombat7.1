// 世界：黄昏天空、程序海洋、岛屿地形、宇宙电梯(轨道电梯 Lighthouse)、Raymarch 体积云
import * as THREE from 'three';
import { fbm2, fbm3, noise3, clamp, lerp, rand, randSpread } from './utils.js';

export const SUN_DIR = new THREE.Vector3(-0.86, 0.15, -0.42).normalize();
const _stormSky = new THREE.Color(0x46505f);
const _stormDeep = new THREE.Color(0x0a1f2c);

// 云层参数（GLSL 与 JS 镜像，保持一致）
const CLOUD_BASE = 480, CLOUD_TOP = 4200;
// 云图覆盖度（世界坐标 → 0..1，大尺度云岸分布，Guerrilla weather map 思路）
export function cloudMapCoverage(x, z) {
  let c = fbm2(x * 0.00003 + 11.7, z * 0.00003 + 4.2, 4);
  return clamp((c - 0.38) * 2.4, 0, 1);
}
// 供主循环做穿云检测（与 shader 同公式）
export function cloudDensityAt(x, y, z, time, coverage) {
  if (y < CLOUD_BASE || y > CLOUD_TOP) return 0;
  const map = cloudMapCoverage(x, z);
  const w = clamp(map * 0.62 + (coverage - 0.45) * 1.05, 0, 1);
  if (w < 0.04) return 0;
  const qx = (x + time * 9) * 0.000075, qy = y * 0.62 * 0.000075, qz = z * 0.000075;
  const base = fbm3(qx, qy, qz, 4);
  let d = base - (1.06 - w * 0.92);
  if (d <= 0) return 0;
  const h = (y - CLOUD_BASE) / (CLOUD_TOP - CLOUD_BASE);
  const grad = clamp(h / 0.07, 0, 1) * (1 - clamp((h - 0.55) / 0.45, 0, 1));
  d *= grad * (0.55 + 1.5 * h);
  if (d < 0.28) {
    const rid = 1 - Math.abs(2 * noise3(x * 0.00085 + time * 2, y * 0.00085, z * 0.00085) - 1);
    d -= (0.28 - d) * rid * 0.6;
  }
  return clamp(d * 2.4, 0, 1.6);
}

// 生成云图纹理（256²，覆盖 ±50km）
function makeCloudMapTexture() {
  const S = 256;
  const data = new Uint8Array(S * S * 4);
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const x = (i / S - 0.5) * 100000;
      const z = (j / S - 0.5) * 100000;
      const c = cloudMapCoverage(x, z);
      const o = (j * S + i) * 4;
      data[o] = Math.round(c * 255);
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, S, S);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// 巨炮地井位置（第二关）
export const SILO_POS = new THREE.Vector3(5400, 0, 4400);

// 共享云场 GLSL（调用前需声明 uniform float time, coverage; uniform sampler2D cloudMap; 阴影函数另需 uniform vec3 sunDir）
export const CLOUD_GLSL = `
  float hashC(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float noiseC(vec3 p){
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hashC(i), n100 = hashC(i + vec3(1.0, 0.0, 0.0));
    float n010 = hashC(i + vec3(0.0, 1.0, 0.0)), n110 = hashC(i + vec3(1.0, 1.0, 0.0));
    float n001 = hashC(i + vec3(0.0, 0.0, 1.0)), n101 = hashC(i + vec3(1.0, 0.0, 1.0));
    float n011 = hashC(i + vec3(0.0, 1.0, 1.0)), n111 = hashC(i + vec3(1.0, 1.0, 1.0));
    return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
               mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
  }
  float fbmC(vec3 p){
    float v = 0.0, a = 0.5;
    for (int k = 0; k < 4; k++){ v += a * noiseC(p); p *= 2.13; a *= 0.5; }
    return v;
  }
  // 云密度场：云图决定地理分布（云岸/晴空区），FBM 塑形，边缘 ridged 侵蚀
  float cloudField(vec3 p){
    if (p.y < 480.0 || p.y > 4200.0) return 0.0;
    float map = texture2D(cloudMap, p.xz * 0.00001 + 0.5).r;
    float w = clamp(map * 0.62 + (coverage - 0.45) * 1.05, 0.0, 1.0);
    if (w < 0.04) return 0.0;
    vec3 q = vec3(p.x + time * 9.0, p.y * 0.62, p.z) * 0.000075;
    float base = fbmC(q);
    float d = base - (1.06 - w * 0.92);
    if (d <= 0.0) return 0.0;
    float h = (p.y - 480.0) / 3720.0;
    float grad = smoothstep(0.0, 0.07, h) * (1.0 - smoothstep(0.55, 1.0, h));
    d *= grad * (0.55 + 1.5 * h);        // 顶部蓬松的积云塔
    if (d < 0.28){
      float rid = 1.0 - abs(2.0 * noiseC(p * 0.00085 + vec3(time * 2.0, 0.0, 0.0)) - 1.0);
      d -= (0.28 - d) * rid * 0.6;
    }
    return clamp(d * 2.4, 0.0, 1.6);
  }
  // 云对地面的投影：直接采样云场本体 → 锐利、跟随云形的影子
  float cloudGroundShadow(vec2 xz){
    vec3 sd = normalize(vec3(sunDir.x, 0.55, sunDir.z));
    vec3 bp = vec3(xz.x, 0.0, xz.y);
    float s = cloudField(bp + sd * 900.0) * 0.7
            + cloudField(bp + sd * 2200.0) * 0.3;
    float sh = smoothstep(0.12, 0.45, s);
    return 1.0 - sh * 0.78 * (0.3 + 0.7 * coverage);
  }
`;

const ISLANDS = [
  { x: 0, z: 0, r: 1500, h: 60 },        // 电梯岛（平坦）
  { x: -4200, z: 2600, r: 1900, h: 230 },
  { x: 3800, z: -4200, r: 1600, h: 170 },
  { x: -2800, z: -5200, r: 1300, h: 130 },
  { x: 5200, z: 4200, r: 2000, h: 270 },
  { x: -700, z: 6400, r: 1100, h: 90 },
];

export function terrainHeight(x, z) {
  let h = -30;
  for (const isl of ISLANDS) {
    const dx = x - isl.x, dz = z - isl.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > isl.r) continue;
    const m = 1 - (d / isl.r) ** 2;
    const detail = fbm2(x * 0.0038 + 7.3, z * 0.0038 + 2.1, 4);
    let ih = Math.pow(m, 1.4) * isl.h * (0.3 + 0.9 * detail);
    if (isl.h === 60) {                       // 电梯岛中心压平用于基座
      const flat = clamp((d - 120) / 380, 0.12, 1);
      ih *= flat;
    }
    h = Math.max(h, ih);
  }
  // 水下部分加速下沉，避免远处海床与海面谈深度冲突（z-fighting）
  if (h < 0) h = Math.max(h * 4, -30);
  return h;
}

export class World {
  constructor(scene) {
    this.scene = scene;
    scene.fog = new THREE.FogExp2(0xc9a88f, 0.00013);

    // ---- 光照 ----
    this.sun = new THREE.DirectionalLight(0xffd9b0, 2.4);
    this.sun.position.copy(SUN_DIR).multiplyScalar(10000);
    scene.add(this.sun);
    this.hemi = new THREE.HemisphereLight(0x9db4d8, 0x4a463c, 0.75);
    scene.add(this.hemi);

    // ---- 天穹（渐变 + 太阳）----
    this.skyUniforms = {
      sunDir: { value: SUN_DIR },
      flash: { value: 0 },
      storm: { value: 0 },
      time: { value: 0 },
      coverage: { value: 0.34 },
      fogColor: { value: new THREE.Color(0xd9ab8a) },
      fogDensity: { value: 0.0001 },
      zenith: { value: new THREE.Color(0x1e2a4a) },
      horizon: { value: new THREE.Color(0xff8c3f) },
      haze: { value: new THREE.Color(0xffc788) },
      sunColor: { value: new THREE.Color(0xffe9c4) },
    };
    const skyMat = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: `
        varying vec3 vDir;
        void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 sunDir, zenith, horizon, haze, sunColor;
        uniform float flash, storm;
        varying vec3 vDir;
        void main(){
          vec3 d = normalize(vDir);
          float sd = max(dot(d, sunDir), 0.0);
          vec3 zenS = mix(zenith, vec3(0.10, 0.12, 0.17), storm);
          vec3 horS = mix(horizon, vec3(0.30, 0.33, 0.40), storm);
          vec3 hazS = mix(haze, vec3(0.36, 0.39, 0.46), storm);
          vec3 col = mix(horS, zenS, pow(clamp(d.y, 0.0, 1.0), 0.48));
          col = mix(col, hazS, smoothstep(0.30, 0.02, abs(d.y)) * 0.75);
          col += sunColor * (pow(sd, 420.0)*2.2 + pow(sd, 26.0)*0.38 + pow(sd, 4.0)*0.16) * (1.0 - storm*0.85);
          col *= (1.0 - storm*0.25);
          col += vec3(0.85, 0.9, 1.0) * flash;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(42000, 28, 18), skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    // ---- 云图纹理 ----
    this.cloudMapTex = makeCloudMapTexture();

    // ---- 海洋 ----
    this.oceanUniforms = {
      time: { value: 0 },
      sunDir: { value: SUN_DIR },
      sunColor: { value: new THREE.Color(0xffd9a0) },
      deepColor: { value: new THREE.Color(0x0d3a54) },
      skyColor: { value: new THREE.Color(0x5d93b8) },
      fogColor: { value: new THREE.Color(0xc9a88f) },
      fogDensity: { value: 0.00013 },
      flash: { value: 0 },
      coverage: this.skyUniforms.coverage,
      cloudMap: { value: this.cloudMapTex },
    };
    const oceanMat = new THREE.ShaderMaterial({
      uniforms: this.oceanUniforms,
      vertexShader: `
        varying vec3 vWorld; varying float vDepth;
        void main(){
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vec4 mv = viewMatrix * wp;
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float time, fogDensity, flash, coverage;
        uniform vec3 sunDir, sunColor, deepColor, skyColor, fogColor;
        uniform sampler2D cloudMap;
        varying vec3 vWorld; varying float vDepth;
        ${CLOUD_GLSL}
        float waveH(vec2 p){
          return 0.55*sin(p.x*0.055 + time*0.9)*sin(p.y*0.047 - time*0.7)
               + 0.30*sin(p.x*0.021 - time*0.5)*sin(p.y*0.026 + time*0.62)
               + 0.18*sin(p.x*0.130 + time*1.7)*sin(p.y*0.110 - time*1.3);
        }
        void main(){
          vec2 p = vWorld.xz;
          float e = 1.4;
          float hC = waveH(p);
          vec3 n = normalize(vec3(hC - waveH(p+vec2(e,0.0)), e*1.7, hC - waveH(p+vec2(0.0,e))));
          vec3 V = normalize(cameraPosition - vWorld);
          vec3 H = normalize(sunDir + V);
          float ndh = max(dot(n, H), 0.0);
          float spec = pow(ndh, 300.0)*2.8 + pow(ndh, 30.0)*0.20;
          float fres = pow(1.0 - max(dot(V, n), 0.0), 3.0);
          vec3 col = mix(deepColor, skyColor, clamp(fres*0.85 + 0.07, 0.0, 1.0));
          col += sunColor * spec;
          col += vec3(0.8,0.85,1.0) * flash * 0.22;
          col *= cloudGroundShadow(vWorld.xz);   // 云的地面阴影
          float f = 1.0 - exp(-fogDensity*fogDensity*vDepth*vDepth);
          col = mix(col, fogColor, f);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const ocean = new THREE.Mesh(new THREE.PlaneGeometry(120000, 120000), oceanMat);
    ocean.rotation.x = -Math.PI / 2;
    ocean.position.y = 0;
    scene.add(ocean);

    // ---- 岛屿地形 ----
    this._buildTerrain();

    // ---- 宇宙电梯 ----
    this._buildElevator();

    this.flashValue = 0;
    this._sunBase = 2.4;
  }

  _buildTerrain() {
    const size = 17000, seg = 210;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const cSand = new THREE.Color(0xa89a70), cGrass = new THREE.Color(0x55703c),
      cForest = new THREE.Color(0x33502e), cRock = new THREE.Color(0x7d7a74),
      cSea = new THREE.Color(0x3d4a42);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = terrainHeight(x, z);
      pos.setY(i, h);
      if (h < 0.5) c.copy(cSea);
      else if (h < 4) c.copy(cSand);
      else if (h < 46) c.copy(cGrass).lerp(cForest, h / 46);
      else if (h < 120) c.copy(cForest).lerp(cRock, (h - 46) / 76);
      else c.copy(cRock);
      c.offsetHSL(0, 0, randSpread(0.03));
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0 });
    // 注入云的地面阴影
    const skyU = this.skyUniforms;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.time = skyU.time;
      shader.uniforms.coverage = skyU.coverage;
      shader.uniforms.sunDir = skyU.sunDir;
      shader.uniforms.cloudMap = { value: this.cloudMapTex };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vCShPos;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvCShPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float time;\nuniform float coverage;\nuniform vec3 sunDir;\nuniform sampler2D cloudMap;\nvarying vec3 vCShPos;\n' + CLOUD_GLSL)
        .replace('#include <dithering_fragment>', 'gl_FragColor.rgb *= cloudGroundShadow(vCShPos.xz);\n#include <dithering_fragment>');
    };
    const terrain = new THREE.Mesh(geo, mat);
    this.scene.add(terrain);

    // 树木（实例化圆锥）
    const treeGeo = new THREE.ConeGeometry(3.2, 13, 6);
    const treeMat = new THREE.MeshStandardMaterial({ color: 0x2c4526, roughness: 1 });
    const trees = new THREE.InstancedMesh(treeGeo, treeMat, 600);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    let n = 0;
    for (let tries = 0; tries < 4000 && n < 600; tries++) {
      const x = randSpread(13000), z = randSpread(13000);
      const h = terrainHeight(x, z);
      if (h < 7 || h > 105) continue;
      const sc = rand(0.6, 1.7);
      s.set(sc, sc * rand(0.9, 1.5), sc);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand(Math.PI * 2));
      m4.compose(new THREE.Vector3(x, h + 5 * s.y, z), q, s);
      trees.setMatrixAt(n++, m4);
    }
    trees.count = n;
    this.scene.add(trees);

    // 电梯岛沿岸小城
    const cityG = new THREE.Group();
    const bMat = new THREE.MeshStandardMaterial({ color: 0x9aa2ac, roughness: 0.7, emissive: 0xffc880, emissiveIntensity: 0.22 });
    for (let i = 0; i < 70; i++) {
      const ang = rand(Math.PI * 2), r = rand(260, 760);
      const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
      const h = terrainHeight(x, z);
      if (h < 2 || h > 40) continue;
      const w = rand(14, 34), bh = rand(10, 62), d = rand(14, 34);
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, bh, d), bMat);
      b.position.set(x, h + bh / 2 - 1, z);
      b.rotation.y = rand(Math.PI);
      cityG.add(b);
    }
    this.scene.add(cityG);
  }

  _buildElevator() {
    const g = this.elevator = new THREE.Group();
    const baseH = Math.max(4, terrainHeight(0, 0));
    g.position.set(0, baseH - 2, 0);

    const metal = new THREE.MeshStandardMaterial({ color: 0xb8c0c8, metalness: 0.85, roughness: 0.3 });
    const metalD = new THREE.MeshStandardMaterial({ color: 0x707880, metalness: 0.8, roughness: 0.45 });
    const glowStrip = new THREE.MeshBasicMaterial({ color: 0xbfe8ff });
    const glowCyan = new THREE.MeshBasicMaterial({ color: 0x7fe8ff });

    // 基座
    const base = new THREE.Mesh(new THREE.CylinderGeometry(240, 280, 46, 8), metalD);
    base.position.y = 23;
    g.add(base);
    for (let i = 0; i < 4; i++) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(26, 220, 26), metalD);
      const a = i * Math.PI / 2 + Math.PI / 4;
      leg.position.set(Math.cos(a) * 150, 100, Math.sin(a) * 150);
      leg.rotation.z = Math.cos(a) * 0.42;
      leg.rotation.x = -Math.sin(a) * 0.42;
      g.add(leg);
    }

    // 主柱
    const pillarH = 2700;
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(7, 24, pillarH, 12), metal);
    pillar.position.y = pillarH / 2 + 40;
    g.add(pillar);
    // 发光竖条（远处可见的光柱效果）
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      const strip = new THREE.Mesh(new THREE.BoxGeometry(1.6, pillarH * 0.98, 1.6), glowStrip);
      strip.position.set(Math.cos(a) * 13, pillarH / 2 + 40, Math.sin(a) * 13);
      g.add(strip);
    }
    // 环
    this.rings = [];
    for (const [y, r] of [[420, 46], [950, 58], [1650, 72], [2300, 60]]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 4.5, 8, 24), metalD);
      ring.position.y = y;
      ring.rotation.x = Math.PI / 2;
      g.add(ring);
      this.rings.push(ring);
    }
    // 顶端配重环 + 辉光核
    const top = new THREE.Mesh(new THREE.TorusGeometry(150, 10, 10, 32), metal);
    top.position.y = pillarH + 60;
    top.rotation.x = Math.PI / 2;
    g.add(top);
    this.rings.push(top);
    const core = new THREE.Mesh(new THREE.SphereGeometry(26, 14, 12), glowCyan);
    core.position.y = pillarH + 60;
    g.add(core);
    this.elevatorCore = core;

    // 红色防撞信标
    this.beacons = [];
    for (const y of [300, 720, 1250, 1850, 2350, 2760]) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(3.2, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xff3524 }));
      b.position.set(16, y, 0);
      g.add(b);
      this.beacons.push(b);
    }
    this.scene.add(g);
  }

  // 闪电闪光 0..1
  setFlash(v) {
    this.flashValue = v;
    this.skyUniforms.flash.value = v;
    this.oceanUniforms.flash.value = v;
    this.sun.intensity = this._sunBase + v * 6;
    this.hemi.intensity = 0.75 + v * 1.6;
  }
  setStorm(v) {
    this.skyUniforms.storm.value = v;
    this._sunBase = 2.4 * (1 - v * 0.55);
    this.oceanUniforms.skyColor.value.set(0x5d93b8).lerp(_stormSky, v);
    this.oceanUniforms.deepColor.value.set(0x0d3a54).lerp(_stormDeep, v);
  }
  setFog(color, density) {
    this.scene.fog.color.set(color);
    this.scene.fog.density = density;
    this.oceanUniforms.fogColor.value.set(color);
    this.oceanUniforms.fogDensity.value = density;
    this.skyUniforms.fogColor.value.set(color);
    this.skyUniforms.fogDensity.value = density;
  }
  setCloudCoverage(v) { this.skyUniforms.coverage.value = v; }

  update(dt, t, camera) {
    this.oceanUniforms.time.value = t;
    this.skyUniforms.time.value = t;
    this.sky.position.copy(camera.position);
    for (const r of this.rings) r.rotation.z += dt * 0.05;
    const pulse = (Math.sin(t * 2.4) > 0.55) ? 1 : 0.12;
    for (const b of this.beacons) b.material.color.setRGB(1 * pulse + 0.15, 0.2 * pulse, 0.14 * pulse);
    this.elevatorCore.material.color.setHSL(0.52, 1, 0.55 + 0.2 * Math.sin(t * 1.7));
  }
}
