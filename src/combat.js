// 战斗：导弹（比例导引）、机炮、MQ-101 无人机 AI、军械巨鸟、爆炸特效池
import * as THREE from 'three';
import { buildDrone, buildArsenalBird, buildMissile } from './models.js';
import { RibbonTrail, makeGlowTexture, clamp, lerp, rand, randSpread, TAU } from './utils.js';
import { terrainHeight } from './world.js';

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

function randVec(s) {
  return new THREE.Vector3(randSpread(s), randSpread(s), randSpread(s));
}

// ============ 特效池 ============
export class Effects {
  constructor(scene, audio) {
    this.scene = scene;
    this.audio = audio;
    this.fireTex = makeGlowTexture(96, 'rgba(255,232,175,1)', 'rgba(255,90,15,0)');
    this.smokeTex = makeGlowTexture(96, 'rgba(125,125,132,0.5)', 'rgba(55,55,62,0)');
    this.parts = [];
    this.pool = [];
    this.lights = [];
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffa040, 0, 1100, 1.7);
      scene.add(l);
      this.lights.push({ l, t: 1 });
    }
    this._li = 0;
  }

  _spawn(tex, pos, vel, size, life, grow, op) {
    let p = this.pool.pop();
    if (!p) {
      p = { sprite: new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false })) };
      p.sprite.renderOrder = 8;
      this.scene.add(p.sprite);
    }
    p.sprite.material.map = tex;
    p.sprite.material.blending = tex === this.smokeTex ? THREE.NormalBlending : THREE.AdditiveBlending;
    p.sprite.material.rotation = rand(TAU);
    p.sprite.material.opacity = op;
    p.sprite.position.copy(pos);
    p.sprite.scale.set(size, size, 1);
    p.sprite.visible = true;
    p.vel = vel; p.life = 0; p.max = life; p.grow = grow; p.op = op;
    this.parts.push(p);
  }

  explosion(pos, size = 1, vol = 1) {
    for (let i = 0; i < 9; i++)
      this._spawn(this.fireTex, pos, randVec(26 * size), rand(13, 24) * size, rand(0.3, 0.55), 95 * size, 1);
    for (let i = 0; i < 7; i++)
      this._spawn(this.smokeTex, pos, randVec(15 * size).add(_v1.set(0, 9, 0)), rand(16, 28) * size, rand(1.3, 2.3), 55 * size, 0.5);
    const L = this.lights[this._li++ % this.lights.length];
    L.l.position.copy(pos);
    L.l.intensity = 900 * size;
    L.t = 0;
    this.audio.explosion(size * vol);
  }

  smokePuff(pos, vel) { this._spawn(this.smokeTex, pos, vel, rand(9, 16), rand(1.4, 2.4), 42, 0.42); }
  spark(pos) {
    for (let i = 0; i < 3; i++) this._spawn(this.fireTex, pos, randVec(22), rand(3, 6), 0.22, 14, 1);
  }

  update(dt) {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life += dt;
      if (p.life >= p.max) {
        p.sprite.visible = false;
        this.parts.splice(i, 1);
        this.pool.push(p);
        continue;
      }
      const f = p.life / p.max;
      p.sprite.position.addScaledVector(p.vel, dt);
      p.vel.y += 6 * dt;
      const s = p.sprite.scale.x + p.grow * dt;
      p.sprite.scale.set(s, s, 1);
      p.sprite.material.opacity = p.op * (1 - f);
    }
    for (const L of this.lights) {
      L.t += dt;
      L.l.intensity *= Math.exp(-7 * dt);
    }
  }
}

// ============ 导弹 ============
const MISSILE_MAX_SPEED = 850;

export class Missile {
  constructor(scene, effects, owner, target, pos, dir, speed0, turnRate, damage) {
    this.scene = scene;
    this.effects = effects;
    this.owner = owner;           // 'player' | 'enemy'
    this.target = target;         // {pos, vel, alive, missileRadius, onMissileHit(dmg)}
    this.dir = dir.clone();
    this.speed = speed0;
    this.turnRate = turnRate;
    this.damage = damage;
    this.life = 5;
    this.alive = true;
    this.guided = true;
    this._closing = false;
    this._prevDist = Infinity;
    this.mesh = buildMissile();
    this.mesh.position.copy(pos);
    this.mesh.quaternion.setFromUnitVectors(_v1.set(0, 0, 1), dir);
    scene.add(this.mesh);
    this.trail = new RibbonTrail(scene, 42, 0.9);
  }

  update(dt) {
    if (!this.alive) return;
    this.life -= dt;
    const pos = this.mesh.position;

    if (this.target.alive && this.guided) {
      const dist = pos.distanceTo(this.target.pos);
      _v1.copy(this.target.vel).multiplyScalar(dist / (this.speed + 1)).add(this.target.pos);
      _v2.copy(_v1).sub(pos).normalize();
      const ang = this.dir.angleTo(_v2);
      if (ang > 1e-4) this.dir.lerp(_v2, Math.min(1, this.turnRate * dt / ang)).normalize();
      if (dist < this.target.missileRadius) {
        this.target.onMissileHit(this.damage);
        this.effects.explosion(pos, this.owner === 'player' ? 1.1 : 0.9);
        this._die();
        return;
      }
      // 脱靶判定：开始远离即失去制导（被急转甩掉）
      if (dist < this._prevDist) this._closing = true;
      else if (this._closing && dist > 60) this.guided = false;
      this._prevDist = dist;
    }
    this.speed = Math.min(MISSILE_MAX_SPEED, this.speed + 320 * dt);
    pos.addScaledVector(this.dir, this.speed * dt);
    this.mesh.quaternion.setFromUnitVectors(_v1.set(0, 0, 1), this.dir);
    this.trail.push(pos, 1);

    if (this.life <= 0 || pos.y < 2 || pos.y < terrainHeight(pos.x, pos.z)) {
      if (pos.y < 30) this.effects.explosion(pos, 0.7, 0.5);
      this._die();
    }
  }

  _die() {
    this.alive = false;
    this.scene.remove(this.mesh);
    this.trail.dispose(this.scene);
  }
}

// ============ 无人机 ============
export class Drone {
  constructor(scene, pos, anchor) {
    const m = buildDrone();
    this.model = m;
    this.group = m.group;
    this.group.position.copy(pos);
    this.scene = scene;
    scene.add(this.group);
    this.speed = rand(230, 285);
    this.hp = 2;
    this.alive = true;
    this.anchor = anchor;
    this.orbitR = rand(750, 1250);
    this.orbitA = rand(TAU);
    this.orbitDir = Math.random() < 0.5 ? 1 : -1;
    this.orbitAlt = rand(450, 1100);
    this.fireCd = rand(5, 11);
    this.weaveT = rand(TAU);
    this.vel = new THREE.Vector3(0, 0, this.speed);
    this.fwd = new THREE.Vector3(0, 0, 1);
    this.missileRadius = 7;
    this.name = 'UAV';
    this.evade = 0;
  }

  get pos() { return this.group.position; }

  onMissileHit(d) { this.hp -= 2; }
  gunHit(d) { this.hp -= d; }

  update(dt, player, combat) {
    if (!this.alive) return;
    const pos = this.pos;
    _v1.copy(player.pos).sub(pos);
    const dist = _v1.length();

    // 目标点：近距离缠斗追玩家，否则绕锚点巡逻
    if (dist < 2400 && player.alive) {
      _v2.copy(player.vel).multiplyScalar(dist / 600).add(player.pos);
    } else {
      this.orbitA += this.speed / this.orbitR * dt * this.orbitDir * 0.6;
      _v2.set(
        this.anchor.x + Math.cos(this.orbitA) * this.orbitR,
        this.orbitAlt + Math.sin(this.orbitA * 2.3) * 90,
        this.anchor.z + Math.sin(this.orbitA) * this.orbitR);
    }
    _v3.copy(_v2).sub(pos).normalize();

    // 规避机动：被导弹锁定时侧向蛇形
    if (this.evade > 0) {
      this.weaveT += dt * 9;
      _v1.set(-_v3.z, 0.3 * Math.sin(this.weaveT * 0.7), _v3.x).normalize();
      _v3.addScaledVector(_v1, Math.sin(this.weaveT) * 0.9).normalize();
    }
    // 地形/海面规避
    const gh = Math.max(terrainHeight(pos.x, pos.z), 0);
    if (pos.y < gh + 190) _v3.y += (gh + 190 - pos.y) / 190 * 1.4;
    if (pos.y > 1750) _v3.y -= 0.5;
    _v3.normalize();

    // 转向（限速率）
    const ang = this.fwd.angleTo(_v3);
    if (ang > 1e-4) this.fwd.lerp(_v3, Math.min(1, 1.7 * dt / ang)).normalize();
    this.vel.copy(this.fwd).multiplyScalar(this.speed);
    pos.addScaledVector(this.vel, dt);
    if (pos.y < gh + 8) pos.y = gh + 8;

    // 姿态：朝速度方向 + 压坡度
    _v1.copy(this.fwd).negate();
    _m4.lookAt(_v2.set(0, 0, 0), _v1, UP);
    this.group.quaternion.setFromRotationMatrix(_m4);
    const lat = _v1.set(1, 0, 0).applyQuaternion(this.group.quaternion).dot(_v3);
    this.group.rotateZ(clamp(-lat * 1.4, -1.1, 1.1));

    // 开火：在玩家后半球且指向玩家
    this.fireCd -= dt;
    if (player.alive && this.fireCd <= 0 && dist < 1100 && dist > 250) {
      const aim = this.fwd.dot(_v1.copy(player.pos).sub(pos).normalize());
      if (aim > 0.94) {
        combat.enemyFire(this);
        this.fireCd = rand(11, 18);
      }
    }
  }
}

// ============ 军械巨鸟 ============
export class ArsenalBird {
  constructor(scene) {
    const m = buildArsenalBird();
    this.model = m;
    this.group = m.group;
    this.scene = scene;
    scene.add(this.group);
    this.angle = rand(TAU);
    this.radius = 2900;
    this.alt = 2450;
    this.targetAlt = 2450;
    this.maxHp = 34;
    this.hp = this.maxHp;
    this.alive = true;
    this.active = false;
    this.falling = false;
    this.fallT = 0;
    this.spawnT = 5;
    this.smokeT = 0;
    this.vel = new THREE.Vector3();
    this.missileRadius = 46;
    this.name = 'ARSENAL BIRD';
    this._deathSeq = -1;
  }

  get pos() { return this.group.position; }

  activate() {
    if (!this.active) {
      this.active = true;
      this.targetAlt = 1350;
    }
  }
  onMissileHit(d) { if (this.active) this.hp -= 1; }
  gunHit(d) { if (this.active) this.hp -= d; }

  update(dt, combat) {
    const g = this.group;
    // 螺旋桨
    for (const p of this.model.props) p.rotation.z += dt * 28;
    // 信标闪烁
    const bl = (Math.sin(performance.now() * 0.004) > 0.4);
    for (const b of this.model.beacons) b.visible = bl;

    if (this.falling) {
      this.fallT += dt;
      g.position.y -= (30 + this.fallT * 55) * dt;
      g.position.addScaledVector(this.vel, dt * 0.35);
      g.rotateZ(dt * 0.5);
      g.rotateX(dt * 0.22);
      if (g.position.y < 12) {
        combat.effects.explosion(g.position, 6, 1.4);
        this.scene.remove(g);
        this.alive = false;
        combat.onBirdDown();
      }
      return;
    }

    if (this.alive) {
      this.angle += 38 / this.radius * dt;
      this.alt = lerp(this.alt, this.targetAlt, Math.min(1, dt * 0.15));
      const x = Math.cos(this.angle) * this.radius;
      const z = Math.sin(this.angle) * this.radius;
      this.vel.set(-Math.sin(this.angle), 0, Math.cos(this.angle)).multiplyScalar(38);
      g.position.set(x, this.alt, z);
      g.quaternion.setFromAxisAngle(UP, -this.angle);
      g.rotateZ(0.1);

      // 死亡序列：连续爆炸后坠落
      if (this.hp <= 0) {
        if (this._deathSeq < 0) this._deathSeq = 0;
        this._deathSeq += dt;
        if (Math.random() < dt * 9) {
          _v1.set(randSpread(180), randSpread(10), randSpread(50)).applyQuaternion(g.quaternion).add(g.position);
          combat.effects.explosion(_v1, rand(1.5, 2.6));
        }
        if (this._deathSeq > 2.2) {
          this.alive = true;      // 保持对象有效直到坠海
          this.falling = true;
          combat.events.onKill('ARSENAL BIRD 失去动力，正在坠落！');
        }
      } else if (this.active) {
        // 释放无人机
        this.spawnT -= dt;
        const cap = this.hp < this.maxHp * 0.5 ? 6 : 4;
        if (this.spawnT <= 0 && combat.countDrones() < cap) {
          this.spawnT = this.hp < this.maxHp * 0.5 ? 8 : 13;
          _v1.set(0, -14, 0).applyQuaternion(g.quaternion).add(g.position);
          combat.spawnDroneAt(_v1);
        }
        // 半血冒烟
        if (this.hp < this.maxHp * 0.5) {
          this.smokeT -= dt;
          if (this.smokeT <= 0) {
            this.smokeT = 0.14;
            _v1.set(rand(40, 110) * (Math.random() < 0.5 ? -1 : 1), 2, randSpread(30)).applyQuaternion(g.quaternion).add(g.position);
            combat.effects.smokePuff(_v1, _v2.copy(this.vel).multiplyScalar(0.4));
          }
        }
      }
    }
  }
}

// ============ 战斗管理器 ============
export class CombatManager {
  constructor(scene, world, player, audio, events) {
    this.scene = scene;
    this.world = world;
    this.player = player;
    this.audio = audio;
    this.events = events;
    this.effects = new Effects(scene, audio);

    this.drones = [];
    this.missiles = [];
    this.bird = new ArsenalBird(scene);
    this.phase = 1;
    this.wave = 0;
    this.score = 0;
    this.killCount = 0;
    this.lock = { target: null, progress: 0, locked: false, hasCandidate: false };
    this.hitMarkT = 0;
    this.gunCd = 0;
    this._ended = false;

    // 玩家作为敌方导弹目标的适配器
    this.playerTarget = {
      pos: player.pos, vel: player.vel, missileRadius: 7,
      get alive() { return player.alive; },
      onMissileHit: (d) => {
        player.damage(d);
        this.audio.hit();
        this.events.onPlayerHit();
      },
    };

    // 曳光弹池
    this.tracers = [];
    for (let i = 0; i < 8; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: 0xffd070, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      line.frustumCulled = false;
      line.renderOrder = 6;
      scene.add(line);
      this.tracers.push({ line, t: 1 });
    }
    this._trI = 0;

    this.spawnWave(5);
  }

  // ---- 目标适配（无人机/巨鸟本身即满足接口）----
  spawnWave(n) {
    this.wave++;
    for (let i = 0; i < n; i++) {
      const a = rand(TAU), r = rand(1400, 3200);
      _v1.set(Math.cos(a) * r, rand(500, 1200), Math.sin(a) * r);
      this.drones.push(new Drone(this.scene, _v1, new THREE.Vector3(0, 800, 0)));
    }
  }
  spawnDroneAt(pos) {
    const d = new Drone(this.scene, pos, this.bird.pos.clone());
    this.drones.push(d);
    this.events.onKill('ARSENAL BIRD 释放了 UAV');
  }
  countDrones() {
    let n = 0;
    for (const d of this.drones) if (d.alive) n++;
    return n;
  }

  enemyFire(drone) {
    _v1.copy(drone.fwd);
    const m = new Missile(this.scene, this.effects, 'enemy', this.playerTarget,
      drone.pos, _v1, drone.speed + 220, 1.55, 30);
    this.missiles.push(m);
    this.audio.missileFire();
  }

  playerFire() {
    const p = this.player;
    if (!p.alive || p.msl <= 0 || !this.lock.locked || !this.lock.target) return false;
    p.msl--;
    _v1.set(0, 0, 1).applyQuaternion(p.group.quaternion);
    _v2.copy(p.pos).addScaledVector(_v1, 8);
    _v2.y -= 1;
    const m = new Missile(this.scene, this.effects, 'player', this.lock.target,
      _v2, _v1, p.speed + 260, 2.2, 100);
    this.missiles.push(m);
    this.audio.missileFire();
    return true;
  }

  updateLock(dt) {
    const p = this.player;
    _v1.set(0, 0, 1).applyQuaternion(p.group.quaternion);
    let best = null, bestScore = 0;
    const consider = (t) => {
      if (!t.alive) return;
      _v2.copy(t.pos).sub(p.pos);
      const dist = _v2.length();
      if (dist > 3500 || dist < 30) return;
      _v2.normalize();
      const c = _v1.dot(_v2);
      if (c < 0.88) return;                    // 约 28° 锁定锥
      const score = c * (1 - dist / 9000);
      if (score > bestScore) { bestScore = score; best = t; }
    };
    for (const d of this.drones) consider(d);
    if (this.bird.active && this.bird.alive && !this.bird.falling) consider(this.bird);

    this.lock.hasCandidate = !!best;
    if (best && best === this.lock.target) {
      this.lock.progress = Math.min(1, this.lock.progress + dt / 0.75);
    } else {
      this.lock.target = best;
      this.lock.progress = best ? dt / 0.75 : 0;
    }
    this.lock.locked = this.lock.progress >= 1 && !!best;
    // 被锁定目标尝试规避
    if (best && best.evade !== undefined && this.lock.progress > 0.4) best.evade = 1.2;
  }

  updateGun(dt, firing) {
    this.gunCd -= dt;
    const p = this.player;
    if (!firing || !p.alive || this.gunCd > 0) return;
    this.gunCd = 1 / 13;
    this.audio.gun();

    _v1.set(0, 0, 1).applyQuaternion(p.group.quaternion);
    _v1.x += randSpread(0.006); _v1.y += randSpread(0.006); _v1.normalize();
    const muzzle = _v2.copy(p.model.gunPos).applyQuaternion(p.group.quaternion).add(p.pos);

    // 命中判定（射线最近距离）
    let hitDist = 900, hitTarget = null;
    const test = (t, radius) => {
      if (!t.alive) return;
      _v3.copy(t.pos).sub(muzzle);
      const along = _v3.dot(_v1);
      if (along < 0 || along > 900) return;
      const closest = _v3.addScaledVector(_v1, -along).length();
      if (closest < radius && along < hitDist) { hitDist = along; hitTarget = t; }
    };
    for (const d of this.drones) test(d, 5.5);
    if (this.bird.active && this.bird.alive && !this.bird.falling) test(this.bird, 120);

    // 曳光
    const tr = this.tracers[this._trI++ % this.tracers.length];
    const a = tr.line.geometry.attributes.position.array;
    a[0] = muzzle.x; a[1] = muzzle.y; a[2] = muzzle.z;
    _v3.copy(muzzle).addScaledVector(_v1, hitTarget ? hitDist : 900);
    a[3] = _v3.x; a[4] = _v3.y; a[5] = _v3.z;
    tr.line.geometry.attributes.position.needsUpdate = true;
    tr.t = 0;

    if (hitTarget) {
      hitTarget.gunHit(hitTarget === this.bird ? 0.09 : 1);
      _v3.copy(muzzle).addScaledVector(_v1, hitDist);
      this.effects.spark(_v3);
      this.hitMarkT = 0.18;
      if (hitTarget !== this.bird && hitTarget.hp <= 0) this._killDrone(hitTarget);
    }
  }

  _killDrone(d) {
    if (!d.alive) return;
    d.alive = false;
    this.effects.explosion(d.pos, 1.3);
    this.scene.remove(d.group);
    this.score += 150;
    this.killCount++;
    this.events.onKill('击坠 UAV +' + 150);
  }

  onBirdDown() {
    this.score += 3000;
    this.killCount++;
    this.events.onKill('摧毁 ARSENAL BIRD +3000');
    setTimeout(() => this.events.onWin(), 1600);
  }

  get incomingAlarm() {
    for (const m of this.missiles) if (m.alive && m.owner === 'enemy') return true;
    return false;
  }

  debugForcePhase2() {
    for (const d of this.drones) { d.alive = false; this.scene.remove(d.group); }
    this.wave = 2;
  }

  update(dt, keys, gunHeld) {
    const p = this.player;

    this.updateLock(dt);
    this.updateGun(dt, gunHeld && p.alive);
    if (keys.Space && p.alive) { this.playerFire(); keys.Space = false; }

    for (const d of this.drones) {
      if (d.evade > 0) d.evade -= dt;
      d.update(dt, p, this);
      if (d.alive && d.hp <= 0) this._killDrone(d);
    }
    // 玩家导弹命中无人机判定在 Missile.update 内通过 onMissileHit → hp 变化，上面统一结算

    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.update(dt);
      if (!m.alive) this.missiles.splice(i, 1);
    }

    this.bird.update(dt, this);

    // 巨鸟压碎判定（撞上即毁）
    if (p.alive && this.bird.alive && !this.bird.falling) {
      if (p.pos.distanceTo(this.bird.pos) < 120) p.damage(200);
    }

    // 阶段推进
    if (this.phase === 1) {
      const alive = this.countDrones();
      if (alive === 0 && this.wave === 1) this.spawnWave(4);
      else if (alive === 0 && this.wave >= 2) {
        this.phase = 2;
        this.bird.activate();
        this.events.onPhase(2);
      }
    }

    // 玩家死亡
    if (!p.alive && !this._ended) {
      this._ended = true;
      this.effects.explosion(p.pos, 2.2);
      p.group.visible = false;
      setTimeout(() => this.events.onLose(), 1400);
    }

    // 玩家导弹命中后无人机的 evade 提示也作用于音效
    this.hitMarkT = Math.max(0, this.hitMarkT - dt);
    for (const tr of this.tracers) {
      tr.t += dt;
      tr.line.material.opacity = Math.max(0, 0.9 - tr.t * 14);
    }
  }

  // HUD 目标列表
  targets() {
    const list = [];
    for (const d of this.drones) if (d.alive) list.push(d);
    if (this.bird.active && this.bird.alive && !this.bird.falling) list.push(this.bird);
    return list;
  }
}
