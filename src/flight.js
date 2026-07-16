// 玩家：街机式飞行模型（皇牌空战手感：压坡度转向、加力、失速）、追逐相机
import * as THREE from 'three';
import { clamp, lerp, damp, RibbonTrail } from './utils.js';
import { buildAircraft } from './models.js';
import { terrainHeight } from './world.js';

const UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _zeroMouse = { x: 0, y: 0 };

export class Player {
  constructor(scene, def) {
    this.def = def;
    const model = buildAircraft(def);
    this.model = model;
    this.group = model.group;
    scene.add(this.group);

    this.group.position.set(6800, 560, 3600);
    _v1.set(-6800, 0, -3600).normalize();
    this.group.quaternion.setFromAxisAngle(UP, Math.atan2(_v1.x, _v1.z));

    this.speed = 330;
    this.hp = def.hp;
    this.maxHp = def.hp;
    this.msl = def.msl;
    this.alive = true;
    this.gforce = 1;
    this.throttle = 0.6;
    this.thrTarget = 0.62;
    this.mouseRef = null;
    this.ab = false;
    this.brake = false;
    this.shake = 0;
    this.stall = false;
    this.alt = 560;
    this.groundH = 0;
    this.vel = new THREE.Vector3();
    this.fwd = new THREE.Vector3(0, 0, 1);
    this.camMode = 0;
    this.invertY = false;
    this._fov = 62;

    this.trailL = new RibbonTrail(scene, 55, 0.5);
    this.trailR = new RibbonTrail(scene, 55, 0.5);
  }

  get pos() { return this.group.position; }

  update(dt, keys, world) {
    if (!this.alive) return;
    const def = this.def;
    const m = this.mouseRef || _zeroMouse;

    // ---- 节流阀（W 加 / S 减）----
    if (keys.KeyW) this.thrTarget = Math.min(1, this.thrTarget + dt * 0.7);
    if (keys.KeyS) this.thrTarget = Math.max(0, this.thrTarget - dt * 0.7);
    this.ab = !!keys.ShiftLeft || !!keys.ShiftRight;
    this.brake = !!keys.ControlLeft || !!keys.ControlRight;

    let target = 170 + this.thrTarget * (def.maxSpeed * 0.9 - 170);
    if (this.ab) target = def.maxSpeed;
    if (this.brake) target = 150;
    const accel = this.speed < target ? def.accel : def.accel * 1.4;
    this.speed += clamp(target - this.speed, -accel * dt, accel * dt);
    this.speed -= (this.gforce - 1) * 9 * dt;                 // 转弯掉速
    this.speed = clamp(this.speed, 90, def.maxSpeed * 1.02);
    this.throttle = lerp(this.throttle, this.ab ? 1 : this.thrTarget, damp(3, dt));

    // ---- 姿态：鼠标指向（机头追随准星）----
    const sf = clamp(1.3 - Math.abs(this.speed - 380) / 900, 0.35, 1.15);
    const mx = Math.abs(m.x) < 0.05 ? 0 : m.x;
    const my = Math.abs(m.y) < 0.05 ? 0 : m.y;
    let pitchRate = (this.invertY ? my : -my) * def.pitch * sf;

    const rightW = _v1.set(1, 0, 0).applyQuaternion(this.group.quaternion);
    const upW = _v2.set(0, 1, 0).applyQuaternion(this.group.quaternion);
    // 压坡度自动带杆（AC 式协调转弯）
    pitchRate += Math.abs(rightW.y) * def.pitch * 0.62 * sf;
    // 滚转：鼠标横向 → 目标坡度；Q/E 手动滚筒（bank>0 = 右压坡）
    const bank = Math.atan2(rightW.y, upW.y);
    const targetBank = mx * 1.35;
    let rollRate = clamp((targetBank - bank) * 4.5, -def.roll, def.roll);
    rollRate += ((keys.KeyE ? 1 : 0) - (keys.KeyQ ? 1 : 0)) * def.roll * 0.9;
    // 平移（方向舵）：A/D，鼠标横向附带少量偏航（yawIn>0 = 右转）
    const yawIn = ((keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0)) + mx * 0.3;
    const yawRate = yawIn * def.yaw * sf;

    // 失速
    this.stall = this.speed < 155;
    if (this.stall) pitchRate -= 0.85;

    _q.setFromAxisAngle(_v3.set(1, 0, 0), -pitchRate * dt);
    this.group.quaternion.multiply(_q);
    _q.setFromAxisAngle(_v3.set(0, 1, 0), -yawRate * dt);
    this.group.quaternion.multiply(_q);
    _q.setFromAxisAngle(_v3.set(0, 0, 1), rollRate * dt);
    this.group.quaternion.multiply(_q);
    this.group.quaternion.normalize();

    // ---- 位置 ----
    this.fwd.set(0, 0, 1).applyQuaternion(this.group.quaternion);
    this.vel.copy(this.fwd).multiplyScalar(this.speed);
    this.group.position.addScaledVector(this.vel, dt);

    // 过载
    this.gforce = 1 + (Math.abs(pitchRate) + Math.abs(yawRate) * 0.5) * this.speed / 120;

    // ---- 地形 / 海面 ----
    this.groundH = Math.max(terrainHeight(this.pos.x, this.pos.z), 0);
    this.alt = this.pos.y - this.groundH;
    if (this.pos.y < this.groundH + 3) { this.alive = false; return; }
    // 软边界
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > 14000) {
      _v1.set(-this.pos.x, 0, -this.pos.z).normalize();
      const yawBack = Math.atan2(_v1.x, _v1.z);
      const cur = Math.atan2(this.fwd.x, this.fwd.z);
      let d = yawBack - cur;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      _q.setFromAxisAngle(UP, d * damp(0.8, dt));
      this.group.quaternion.premultiply(_q);
    }

    // ---- 加力燃烧室 ----
    for (const b of this.model.burners) {
      b.visible = this.throttle > 0.72;
      if (b.visible) {
        const s = 0.8 + Math.random() * 0.5;
        b.scale.set(s, s, 0.8 + Math.random() * 0.9);
        b.material.opacity = 0.55 + Math.random() * 0.4;
      }
    }

    // ---- 翼尖凝结尾 ----
    const trailS = clamp((this.gforce - 2.2) / 5, 0, 1) + (this.pos.y > 750 ? 0.35 : 0);
    for (let i = 0; i < 2; i++) {
      const trail = i === 0 ? this.trailL : this.trailR;
      _v1.copy(this.model.wingtips[i]).applyQuaternion(this.group.quaternion).add(this.pos);
      trail.push(_v1, clamp(trailS, 0, 1));
    }

    this.shake = Math.max(0, this.shake - dt * 2.2);
  }

  updateCamera(camera, dt, t) {
    const mode = this.camMode;
    this.group.visible = mode !== 2;

    // ---- 座舱视角（FOV 90）----
    if (mode === 2) {
      _v1.set(0, 2.05, 3.4).applyQuaternion(this.group.quaternion).add(this.pos);
      camera.position.lerp(_v1, damp(40, dt));
      _v2.copy(this.fwd).multiplyScalar(120).add(this.pos);
      _v2.y += 3.5;
      camera.lookAt(_v2);
      _v3.set(0, 1, 0).applyQuaternion(this.group.quaternion);
      camera.up.lerp(_v3, damp(14, dt)).normalize();
      const fovT = 90 + (this.ab ? 3 : 0);
      this._fov = lerp(this._fov, fovT, damp(6, dt));
      if (Math.abs(camera.fov - this._fov) > 0.05) {
        camera.fov = this._fov;
        camera.updateProjectionMatrix();
      }
      const sh2 = this.shake + clamp((this.gforce - 6) / 18, 0, 0.35);
      if (sh2 > 0.01) {
        camera.position.x += (Math.random() - 0.5) * sh2 * 0.5;
        camera.position.y += (Math.random() - 0.5) * sh2 * 0.5;
      }
      return;
    }

    // ---- 追逐视角 ----
    _v1.set(0, mode === 0 ? 3.4 : 5.5, mode === 0 ? -13.5 : -24).applyQuaternion(this.group.quaternion).add(this.pos);
    camera.position.lerp(_v1, damp(mode === 0 ? 14 : 9, dt));
    _v2.copy(this.fwd).multiplyScalar(60).add(this.pos);
    _v2.y += 2;
    camera.lookAt(_v2);
    // 相机随滚转倾斜
    _v3.set(0, 1, 0).applyQuaternion(this.group.quaternion);
    camera.up.lerp(_v3, damp(6, dt)).normalize();
    // FOV 随速度扩张
    const fovT = 62 + (this.speed / this.def.maxSpeed) * 13 + (this.ab ? 6 : 0);
    this._fov = lerp(this._fov, fovT, damp(5, dt));
    if (Math.abs(camera.fov - this._fov) > 0.05) {
      camera.fov = this._fov;
      camera.updateProjectionMatrix();
    }
    // 抖动（高G / 受击）
    const sh = this.shake + clamp((this.gforce - 6) / 20, 0, 0.3);
    if (sh > 0.01) {
      camera.position.x += (Math.random() - 0.5) * sh * 0.9;
      camera.position.y += (Math.random() - 0.5) * sh * 0.9;
    }
  }

  damage(n) {
    if (!this.alive) return;
    this.hp -= n;
    this.shake = Math.min(2, this.shake + 1.2);
    if (this.hp <= 0) { this.hp = 0; this.alive = false; }
  }
}
