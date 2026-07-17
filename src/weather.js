// 动态天气：晴空 → 多云 → 降雨 → 雷暴；雨幕粒子、闪电、闪光、雾联动
import * as THREE from 'three';
import { clamp, lerp, rand, randSpread } from './utils.js';

export const WEATHER_STATES = [
  { key: 'CLEAR',  cov: 0.40, rain: 0,    storm: 0,    fog: 0.00010, fogCol: new THREE.Color(0xd9ab8a), bolt: 0,    form: [0.42, 1.5, 0.85, 0.85] },
  { key: 'CLOUDY', cov: 0.66, rain: 0,    storm: 0.20, fog: 0.00016, fogCol: new THREE.Color(0xb79b8d), bolt: 0,    form: [0.55, 1.9, 0.65, 0.62] },
  { key: 'RAIN',   cov: 0.88, rain: 0.65, storm: 0.45, fog: 0.00024, fogCol: new THREE.Color(0x848b9a), bolt: 0.12, form: [0.72, 2.3, 0.45, 0.50] },
  { key: 'STORM',  cov: 1.00, rain: 1.00, storm: 0.85, fog: 0.00030, fogCol: new THREE.Color(0x646d7d), bolt: 1,    form: [0.85, 2.7, 0.35, 0.42] },
];

const RAIN_N = 2200;

export class Weather {
  constructor(scene, world, audio) {
    this.scene = scene;
    this.world = world;
    this.audio = audio;

    this.stateIdx = 0;
    this.cur = { cov: 0.40, rain: 0, storm: 0, fog: 0.00010, fogCol: WEATHER_STATES[0].fogCol.clone(), bolt: 0, form: WEATHER_STATES[0].form.slice() };
    this.autoT = 0;
    this.flash = 0;
    this._boltT = 3;
    this.bolts = [];

    // ---- 雨幕 ----
    this.rainPos = new Float32Array(RAIN_N * 6);
    this.drops = [];
    for (let i = 0; i < RAIN_N; i++) {
      this.drops.push({
        x: randSpread(70), y: rand(-25, 35), z: randSpread(70),
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    this.rainMat = new THREE.LineBasicMaterial({
      color: 0x9fb4cc, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.rain = new THREE.LineSegments(geo, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 6;
    scene.add(this.rain);

    this.boltMatCore = new THREE.LineBasicMaterial({ color: 0xf2f6ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    this.boltMatGlow = new THREE.LineBasicMaterial({ color: 0x7f9dff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false });
  }

  setState(i) {
    this.stateIdx = clamp(i, 0, WEATHER_STATES.length - 1);
    this.autoT = 0;
  }

  get target() { return WEATHER_STATES[this.stateIdx]; }
  get rainIntensity() { return this.cur.rain; }
  get coverage() { return this.cur.cov; }
  get cloudForm() { return this.cur.form; }

  _strike(camPos) {
    const ang = rand(Math.PI * 2), dist = rand(500, 2600);
    const bx = camPos.x + Math.cos(ang) * dist;
    const bz = camPos.z + Math.sin(ang) * dist;
    const top = rand(620, 980);
    const n = 22;
    const pts = [];
    let x = bx, z = bz;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      pts.push(new THREE.Vector3(x, top * (1 - t), z));
      x += randSpread(55) * (1 - t * 0.4);
      z += randSpread(55) * (1 - t * 0.4);
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const core = new THREE.Line(geo, this.boltMatCore.clone());
    const glow = new THREE.Line(geo, this.boltMatGlow.clone());
    core.renderOrder = 7; glow.renderOrder = 7;
    core.frustumCulled = glow.frustumCulled = false;
    this.scene.add(core); this.scene.add(glow);
    this.bolts.push({ core, glow, life: 0, max: rand(0.16, 0.3) });
    this.audio.thunder(dist);
    return dist;
  }

  update(dt, t, camPos, playerVel, autoCycle = true) {
    // 参数向目标缓动
    const tg = this.target, c = this.cur;
    const k = Math.min(1, dt * 0.35);
    c.cov = lerp(c.cov, tg.cov, k);
    c.rain = lerp(c.rain, tg.rain, Math.min(1, dt * 0.5));
    c.storm = lerp(c.storm, tg.storm, k);
    c.fog = lerp(c.fog, tg.fog, k);
    c.bolt = lerp(c.bolt, tg.bolt, k);
    c.fogCol.lerp(tg.fogCol, k);
    for (let i = 0; i < 4; i++) c.form[i] = lerp(c.form[i], tg.form[i], k);

    this.world.setFog(c.fogCol, c.fog);
    this.world.setStorm(c.storm);
    this.world.setCloudCoverage(c.cov);
    this.world.skyUniforms.cloudForm.value.set(c.form[0], c.form[1], c.form[2], c.form[3]);

    // 自动轮换天气
    if (autoCycle) {
      this.autoT += dt;
      if (this.autoT > 85) {
        this.autoT = 0;
        this.setState((this.stateIdx + 1) % WEATHER_STATES.length);
      }
    }

    // ---- 雨 ----
    const inten = c.rain;
    this.rainMat.opacity = inten * 0.20;
    if (inten > 0.02) {
      const streak = 0.055;
      const vx = -playerVel.x * streak, vy = (-56 - playerVel.y) * streak, vz = -playerVel.z * streak;
      for (let i = 0; i < RAIN_N; i++) {
        const d = this.drops[i];
        d.y -= 56 * dt;
        d.x -= playerVel.x * dt * 0.4;
        d.z -= playerVel.z * dt * 0.4;
        if (d.y < -28) { d.y = 32; d.x = randSpread(70); d.z = randSpread(70); }
        if (Math.abs(d.x) > 38) d.x = randSpread(70);
        if (Math.abs(d.z) > 38) d.z = randSpread(70);
        const wx = camPos.x + d.x, wy = camPos.y + d.y, wz = camPos.z + d.z;
        const o = i * 6;
        this.rainPos[o] = wx; this.rainPos[o + 1] = wy; this.rainPos[o + 2] = wz;
        this.rainPos[o + 3] = wx + vx; this.rainPos[o + 4] = wy + vy; this.rainPos[o + 5] = wz + vz;
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
      this.rain.visible = true;
    } else this.rain.visible = false;

    // ---- 闪电 ----
    this._boltT -= dt * (0.2 + c.bolt * 1.6);
    if (this._boltT <= 0 && c.bolt > 0.03) {
      this._boltT = rand(2.5, 8);
      this._strike(camPos);
      if (c.bolt > 0.7 && Math.random() < 0.4) this._strike(camPos);
    }
    let f = 0;
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.life += dt;
      const p = b.life / b.max;
      if (p >= 1) {
        this.scene.remove(b.core); this.scene.remove(b.glow);
        b.core.geometry.dispose();
        this.bolts.splice(i, 1);
        continue;
      }
      const flick = (Math.sin(b.life * 90) > -0.2 ? 1 : 0.25) * (1 - p);
      b.core.material.opacity = 0.95 * flick;
      b.glow.material.opacity = 0.4 * flick;
      f = Math.max(f, flick);
    }
    this.flash = lerp(this.flash, f, Math.min(1, dt * 30));
    this.world.setFlash(this.flash);
  }
}
