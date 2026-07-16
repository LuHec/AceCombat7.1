// 第二关：SAM 地面设施、地井（圆形地面门开启）+ 巨炮、僚机
import * as THREE from 'three';
import { buildSAMSite, buildSilo, buildAircraft, ENEMY_DEF } from './models.js';
import { RibbonTrail, clamp, lerp, damp, rand, TAU } from './utils.js';
import { terrainHeight, SILO_POS } from './world.js';

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// ============ SAM 防空导弹设施 ============
export class SAMSite {
  constructor(scene, x, z) {
    const m = buildSAMSite();
    this.model = m;
    this.group = m.group;
    const y = terrainHeight(x, z);
    this.group.position.set(x, y - 0.5, z);
    scene.add(this.group);
    this.scene = scene;
    this.hp = 4;
    this.alive = true;
    this.missileRadius = 16;
    this.name = 'SAM 设施';
    this.fireT = rand(5, 10);
    this._smokeT = 0;
  }
  get pos() { return this.group.position; }
  onMissileHit() { this.hp -= 2; }
  gunHit(d) { this.hp -= d; }

  update(dt, player, combat) {
    this.model.dish.rotation.y += dt * 0.9;
    const bl = Math.sin(performance.now() * 0.006) > 0.3;
    this.model.beacon.visible = this.alive && bl;
    if (!this.alive) {
      // 残骸冒烟
      this._smokeT -= dt;
      if (this._smokeT <= 0 && Math.random() < 0.4) {
        this._smokeT = 0.5;
        _v1.copy(this.pos); _v1.y += 6;
        combat.effects.smokePuff(_v1, _v2.set(rand(2, 6), 8, rand(-2, 2)));
      }
      return;
    }
    if (!player.alive) return;
    const dist = this.pos.distanceTo(player.pos);
    this.fireT -= dt;
    if (this.fireT <= 0 && dist < 3800) {
      this.fireT = rand(9, 15);
      combat.samFire(this);
    }
  }
}

// ============ 地井（门开 → 平台升起 → 巨炮作战）===========
export class Silo {
  constructor(scene, audio) {
    const m = buildSilo();
    this.model = m;
    this.group = m.group;
    const y = terrainHeight(SILO_POS.x, SILO_POS.z);
    this.group.position.set(SILO_POS.x, y, SILO_POS.z);
    scene.add(this.group);
    this.scene = scene;
    this.audio = audio;
    this.state = 'closed';   // closed → opening → rising → active
    this.t = 0;
    this.cannon = new Cannon(m, this.group.position.y);
  }

  open() {
    if (this.state === 'closed') {
      this.state = 'opening';
      this.t = 0;
      this.audio.thunder(600);
    }
  }

  update(dt, combat) {
    const m = this.model;
    if (this.state === 'opening') {
      this.t += dt;
      const k = clamp(this.t / 8, 0, 1);
      const e = 1 - (1 - k) * (1 - k);          // easeOut
      for (const d of m.doors) {
        d.mesh.position.copy(d.dir).multiplyScalar(230 * e);
        d.mesh.position.y = -14 * e;
      }
      if (k >= 1) { this.state = 'rising'; this.t = 0; this.audio.thunder(300); }
    } else if (this.state === 'rising') {
      this.t += dt;
      const k = clamp(this.t / 10, 0, 1);
      const e = k * k * (3 - 2 * k);            // smoothstep
      m.platform.position.y = lerp(-118, 20, e);
      if (k >= 1) {
        this.state = 'active';
        this.cannon.active = true;
        combat.onCannonReady();
      }
    }
    this.cannon.update(dt, combat);
    // 警示灯
    const bl = Math.sin(performance.now() * 0.005) > 0.2;
    for (const b of m.beacons) b.visible = bl;
  }
}

// ============ 巨炮 ============
export class Cannon {
  constructor(model, baseY) {
    this.model = model;
    this.baseY = baseY;
    this.maxHp = 60;
    this.hp = this.maxHp;
    this.alive = true;
    this.active = false;
    this.missileRadius = 80;
    this.name = '巨炮';
    this.chargeT = 12;
    this.charging = 0;      // >0 表示正在充能
    this.dead = false;
    this.vel = new THREE.Vector3();
    this._deathT = 0;
  }
  get pos() { return this.model.barrelG.getWorldPosition(_v3.set(0, 0, 0)); }
  onMissileHit() { if (this.active) this.hp -= 1; }
  gunHit(d) { if (this.active) this.hp -= d; }

  update(dt, combat) {
    if (this.dead) {
      this._deathT += dt;
      if (Math.random() < dt * 6) {
        _v1.copy(this.pos).add(_v2.set(rand(-60, 60), rand(-10, 30), rand(-60, 60)));
        combat.effects.explosion(_v1, rand(1.5, 3));
      }
      return;
    }
    const player = combat.player;
    // 炮塔缓慢指向玩家
    if (this.active && player.alive) {
      _v1.copy(player.pos).sub(this.model.platform.getWorldPosition(_v2));
      const yaw = Math.atan2(_v1.x, _v1.z);
      let d = yaw - this.model.turret.rotation.y;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      this.model.turret.rotation.y += d * damp(0.6, dt);
    }
    // 充能/开火
    if (this.active && this.alive && player.alive) {
      this.chargeT -= dt;
      if (this.chargeT <= 0 && this.charging <= 0) {
        this.charging = 2.2;
        combat.events.onKill('⚠ 侦测到巨炮充能！');
      }
      if (this.charging > 0) {
        this.charging -= dt;
        const s = 1 + (2.2 - this.charging) * 0.8;
        this.model.core.scale.set(s, s, s);
        if (this.charging <= 0) {
          this.model.core.scale.set(1, 1, 1);
          combat.cannonFire(this);
          this.chargeT = rand(13, 18);
        }
      }
    }
    if (this.hp <= 0 && this.alive) {
      this.alive = false;
      this.dead = true;
      combat.effects.explosion(this.pos, 4, 1.5);
      combat.onCannonDown();
    }
  }
}

// ============ 巨炮炮弹 ============
export class CannonShell {
  constructor(scene, effects, from, targetPos) {
    this.scene = scene;
    this.effects = effects;
    this.alive = true;
    this.life = 7;
    const geo = new THREE.SphereGeometry(4, 10, 8);
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffcc66 }));
    this.mesh.position.copy(from);
    scene.add(this.mesh);
    this.vel = _v1.copy(targetPos).sub(from).normalize().multiplyScalar(520).clone();
    this.trail = new RibbonTrail(scene, 50, 1.2);
  }
  get pos() { return this.mesh.position; }

  update(dt, player) {
    if (!this.alive) return;
    this.life -= dt;
    this.pos.addScaledVector(this.vel, dt);
    this.trail.push(this.pos, 1);
    const dp = this.pos.distanceTo(player.pos);
    if (dp < 60) {
      this.effects.explosion(this.pos, 3.5, 1.4);
      player.damage(60);
      this._die();
      return;
    }
    if (this.pos.y < terrainHeight(this.pos.x, this.pos.z) + 3 || this.life <= 0) {
      this.effects.explosion(this.pos, 3.0, 1.0);
      if (dp < 100) player.damage(35);
      this._die();
    }
  }
  _die() {
    this.alive = false;
    this.scene.remove(this.mesh);
    this.trail.dispose(this.scene);
  }
}

// ============ 僚机 ============
export class Wingman {
  constructor(scene, player, side) {
    const m = buildAircraft({ id: 'f16', color: 0x86a0b8, name: 'F-16C' });
    this.model = m;
    this.group = m.group;
    this.player = player;
    this.side = side;
    scene.add(this.group);
    this.fireT = rand(4, 7);
    this.pos.copy(this._slot());
  }
  get pos() { return this.group.position; }

  _slot() {
    return _v1.set(this.side * 55, 8, -90).applyQuaternion(this.player.group.quaternion).add(this.player.pos);
  }

  update(dt, combat) {
    const p = this.player;
    // 编队跟随
    _v2.copy(this._slot());
    this.pos.lerp(_v2, damp(2.4, dt));
    this.group.quaternion.slerp(p.group.quaternion, damp(3.2, dt));
    for (const b of this.model.burners) b.visible = p.throttle > 0.72;

    // 支援开火
    this.fireT -= dt;
    if (this.fireT <= 0 && p.alive) {
      this.fireT = rand(6, 10);
      let best = null, bestD = 2800;
      for (const e of combat.drones) {
        if (!e.alive) continue;
        const d = e.pos.distanceTo(this.pos);
        if (d < bestD) {
          _v3.copy(e.pos).sub(this.pos).normalize();
          const fwd = _v1.set(0, 0, 1).applyQuaternion(this.group.quaternion);
          if (fwd.dot(_v3) > 0.75) { best = e; bestD = d; }
        }
      }
      if (best) combat.wingmanFire(this, best);
    }
  }
}
