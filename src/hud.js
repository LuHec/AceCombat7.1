// HUD：全屏 2D 画布 —— 速度/高度/姿态仪/雷达/目标框/导弹锁定/告警/座舱雨滴
import * as THREE from 'three';
import { clamp, lerp, projectToScreen, TAU } from './utils.js';

const GREEN = '#8cffc9', WHITE = '#e8f4ff', RED = '#ff5a4a', AMBER = '#ffc35a', DIM = '#5d8f7d';
const _v = new THREE.Vector3();
const _p = { x: 0, y: 0, behind: false };

export class HUD {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.drops = [];
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.canvas.width = this.W * dpr;
    this.canvas.height = this.H * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _t(str, x, y, size = 14, color = GREEN, align = 'left', glow = false) {
    const c = this.ctx;
    c.font = `${size}px Consolas, "Courier New", monospace`;
    c.textAlign = align;
    c.textBaseline = 'middle';
    if (glow) { c.shadowColor = color; c.shadowBlur = 10; } else c.shadowBlur = 0;
    c.fillStyle = color;
    c.fillText(str, x, y);
    c.shadowBlur = 0;
  }

  draw(g, dt) {
    const c = this.ctx, W = this.W, H = this.H;
    c.clearRect(0, 0, W, H);
    const p = g.player;
    if (!p) return;
    const cx = W / 2, cy = H / 2;
    const blink = (g.time % 0.5) < 0.28;

    if (p.camMode === 2) this._cockpitFrame(W, H);

    // ============ 姿态仪 ============
    const rightW = _v.set(1, 0, 0).applyQuaternion(p.group.quaternion);
    const upW = new THREE.Vector3(0, 1, 0).applyQuaternion(p.group.quaternion);
    const roll = Math.atan2(rightW.y, upW.y);
    const pitchDeg = Math.asin(clamp(p.fwd.y, -1, 1)) * 180 / Math.PI;
    c.save();
    c.translate(cx, cy);
    c.rotate(-roll);
    c.strokeStyle = 'rgba(140,255,201,0.55)';
    c.lineWidth = 1.5;
    for (let pa = -30; pa <= 30; pa += 10) {
      const rel = pa - pitchDeg;
      if (Math.abs(rel) > 26) continue;
      const y = rel * 5;
      const w = pa === 0 ? 130 : (pa % 20 === 0 ? 80 : 50);
      c.beginPath();
      c.moveTo(-w, y); c.lineTo(-w * 0.25, y);
      c.moveTo(w * 0.25, y); c.lineTo(w, y);
      if (pa !== 0) {
        c.moveTo(-w, y); c.lineTo(-w, y + (pa > 0 ? -7 : 7));
        c.moveTo(w, y); c.lineTo(w, y + (pa > 0 ? -7 : 7));
      }
      c.stroke();
      if (pa !== 0) {
        this._t(String(Math.abs(pa)), -w - 26, y, 11, 'rgba(140,255,201,0.6)', 'center');
        this._t(String(Math.abs(pa)), w + 26, y, 11, 'rgba(140,255,201,0.6)', 'center');
      }
    }
    c.restore();
    // 中心标线（固定 W 形）
    c.strokeStyle = GREEN;
    c.lineWidth = 2;
    c.beginPath();
    c.stroke();
    // 鼠标指向准星
    if (g.mouse && g.mode === 'play') {
      const rx = cx + g.mouse.x * cx, ry = cy + g.mouse.y * cy;
      c.strokeStyle = 'rgba(140,255,201,0.8)';
      c.lineWidth = 1.5;
      c.beginPath(); c.arc(rx, ry, 9, 0, TAU); c.stroke();
      c.beginPath();
      c.moveTo(rx - 16, ry); c.lineTo(rx - 5, ry);
      c.moveTo(rx + 5, ry); c.lineTo(rx + 16, ry);
      c.moveTo(rx, ry - 16); c.lineTo(rx, ry - 5);
      c.moveTo(rx, ry + 5); c.lineTo(rx, ry + 16);
      c.stroke();
    }

    // ============ 罗盘带 ============
    const hdg = (Math.atan2(p.fwd.x, p.fwd.z) * 180 / Math.PI + 360) % 360;
    c.strokeStyle = 'rgba(140,255,201,0.5)';
    c.strokeRect(cx - 160, 18, 320, 26);
    const labels = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    for (let a = -60; a <= 60; a += 5) {
      let d = Math.round((hdg + a) / 5) * 5;
      const dd = ((d - hdg + 540) % 360) - 180;
      if (Math.abs(dd) > 60) continue;
      const x = cx + dd * 2.6;
      d = (d + 360) % 360;
      c.strokeStyle = 'rgba(140,255,201,0.5)';
      c.beginPath(); c.moveTo(x, 32); c.lineTo(x, d % 15 === 0 ? 40 : 36); c.stroke();
      if (labels[d] !== undefined) this._t(labels[d], x, 26, 13, WHITE, 'center');
      else if (d % 30 === 0) this._t(String(d / 10), x, 26, 11, DIM, 'center');
    }
    this._t('▼', cx, 12, 10, GREEN, 'center');

    // ============ 左：速度 / G / 油门 ============
    const kmh = Math.round(p.speed * 3.6);
    this._t('SPEED', 40, cy - 60, 12, DIM);
    this._t(String(kmh), 40, cy - 30, 34, GREEN, 'left', true);
    this._t('KM/H', 40, cy - 2, 12, DIM);
    this._t(`G ${p.gforce.toFixed(1)}`, 40, cy + 24, 14, p.gforce > 7 ? RED : GREEN);
    // 油门条
    c.strokeStyle = DIM;
    c.strokeRect(40, cy + 40, 12, 90);
    c.fillStyle = p.ab ? AMBER : GREEN;
    const th = clamp(p.throttle, 0, 1);
    c.fillRect(42, cy + 128 - th * 86, 8, th * 86);
    this._t(p.ab ? 'AB' : 'THR', 58, cy + 50, 11, p.ab ? AMBER : DIM);

    // ============ 右：高度 ============
    this._t('ALT', W - 40, cy - 60, 12, DIM, 'right');
    this._t(String(Math.max(0, Math.round(p.alt))), W - 40, cy - 30, 34, GREEN, 'right', true);
    this._t('M', W - 40, cy - 2, 12, DIM, 'right');
    this._t(`HDG ${String(Math.round(hdg)).padStart(3, '0')}`, W - 40, cy + 24, 14, GREEN, 'right');

    // ============ 雷达 ============
    this._radar(g, 118, H - 132, 88);

    // ============ 武器 ============
    this._t(p.def.name, W - 40, H - 178, 14, WHITE, 'right');
    this._t(`MSL ${p.msl}`, W - 40, H - 152, 20, p.msl < 8 ? AMBER : GREEN, 'right', true);
    const pips = Math.min(p.msl, 16);
    for (let i = 0; i < pips; i++) {
      c.fillStyle = i < p.msl ? GREEN : '#234';
      c.fillRect(W - 44 - i * 11, H - 128, 7, 14);
    }
    this._t('GUN ∞', W - 40, H - 100, 14, GREEN, 'right');
    if (g.combat.bird && g.combat.bird.active && g.combat.bird.alive) {
      const b = g.combat.bird;
      this._t(`巨鸟装甲 ${Math.max(0, Math.ceil(b.hp))}/${b.maxHp}`, W - 40, H - 74, 13, RED, 'right');
    }
    if (g.combat.silo && g.combat.silo.cannon.active && g.combat.silo.cannon.alive) {
      const cn = g.combat.silo.cannon;
      this._t(`巨炮装甲 ${Math.max(0, Math.ceil(cn.hp))}/${cn.maxHp}`, W - 40, H - 74, 13, RED, 'right');
    }

    // ============ 目标框 ============
    const lock = g.combat.lock;
    for (const t of g.combat.targets()) {
      if (!projectToScreen(t.pos, g.camera, W, H, _p)) continue;
      const dist = t.pos.distanceTo(p.pos);
      const s = clamp(2600 / dist * 10, 12, t.name === 'ARSENAL BIRD' ? 90 : 44);
      const isLock = lock.target === t;
      c.strokeStyle = isLock && lock.locked ? RED : 'rgba(255,90,74,0.85)';
      c.lineWidth = isLock ? 2 : 1;
      c.strokeRect(_p.x - s, _p.y - s * 0.7, s * 2, s * 1.4);
      this._t(`${t.name} ${(dist / 1000).toFixed(1)}`, _p.x, _p.y + s * 0.7 + 12, 11, RED, 'center');
      if (isLock) {
        // 锁定进度环
        c.strokeStyle = lock.locked ? RED : AMBER;
        c.lineWidth = 2.5;
        c.beginPath();
        c.arc(_p.x, _p.y, s + 10, -Math.PI / 2, -Math.PI / 2 + lock.progress * TAU);
        c.stroke();
        if (lock.locked && blink) {
          c.save();
          c.translate(_p.x, _p.y);
          c.rotate(g.time * 2);
          c.strokeRect(-s - 4, -s - 4, (s + 4) * 2, (s + 4) * 2);
          c.restore();
        }
      }
    }
    // 锁定状态 / SHOOT
    if (lock.locked) {
      if (blink) this._t('◉ SHOOT', cx, cy + 74, 20, AMBER, 'center', true);
    } else if (lock.hasCandidate) {
      this._t('LOCKING…', cx, cy + 74, 13, AMBER, 'center');
    }

    // ============ 告警 ============
    let wy = cy - 130;
    if (g.combat.incomingAlarm && blink) {
      this._t('⚠ MISSILE ALERT', cx, wy, 24, RED, 'center', true);
      wy += 30;
    }
    if (p.alive && p.alt < 100 && p.fwd.y < -0.06 && blink) {
      this._t('⚠ PULL UP', cx, wy, 22, RED, 'center', true);
      wy += 28;
    }
    if (p.stall && blink) {
      this._t('STALL', cx, wy, 18, AMBER, 'center');
      wy += 26;
    }
    if (g.combat.silo && g.combat.silo.cannon.charging > 0 && blink) {
      this._t('⚠ 巨炮充能', cx, wy, 22, AMBER, 'center', true);
      wy += 28;
    }

    // ============ 命中标记 ============
    if (g.combat.hitMarkT > 0) {
      c.strokeStyle = WHITE;
      c.lineWidth = 2.5;
      const m = 12;
      c.beginPath();
      c.moveTo(cx - m, cy - m); c.lineTo(cx - m / 2.5, cy - m / 2.5);
      c.moveTo(cx + m, cy - m); c.lineTo(cx + m / 2.5, cy - m / 2.5);
      c.moveTo(cx - m, cy + m); c.lineTo(cx - m / 2.5, cy + m / 2.5);
      c.moveTo(cx + m, cy + m); c.lineTo(cx + m / 2.5, cy + m / 2.5);
      c.stroke();
    }

    // ============ 任务信息 ============
    this._t(g.mission, cx, 62, 15, WHITE, 'center', true);
    this._t(`SCORE ${g.combat.score}`, W - 40, 62, 16, GREEN, 'right');
    const mt = Math.floor(g.time / 60), st = Math.floor(g.time % 60);
    this._t(`T+${mt}:${String(st).padStart(2, '0')}`, W - 40, 84, 13, DIM, 'right');

    // 击坠播报
    let fy = 120;
    for (const f of g.feed) {
      const a = clamp(1 - f.t / 5, 0, 1);
      this._t(f.msg, W - 40, fy, 13, `rgba(255,217,138,${a})`, 'right');
      fy += 20;
    }

    // ============ 座舱雨滴 ============
    this._droplets(g, dt);
  }

  // 座舱框架（座舱视角时绘制在 HUD 底层）
  _cockpitFrame(W, H) {
    const c = this.ctx;
    c.save();
    c.fillStyle = 'rgba(6, 8, 12, 0.97)';
    // 下仪表台
    c.beginPath();
    c.moveTo(0, H);
    c.lineTo(0, H - 60);
    c.quadraticCurveTo(W * 0.5, H - 170, W, H - 60);
    c.lineTo(W, H);
    c.closePath();
    c.fill();
    // 两侧支柱
    c.beginPath();
    c.moveTo(0, 0); c.lineTo(90, 0); c.lineTo(34, H); c.lineTo(0, H);
    c.closePath(); c.fill();
    c.beginPath();
    c.moveTo(W, 0); c.lineTo(W - 90, 0); c.lineTo(W - 34, H); c.lineTo(W, H);
    c.closePath(); c.fill();
    // 顶部遮阳框
    c.fillRect(0, 0, W, 26);
    // 前框中柱
    c.fillRect(W / 2 - 7, 0, 14, H * 0.16);
    // 台面上的绿色荧光条
    c.fillStyle = 'rgba(90, 255, 190, 0.16)';
    c.fillRect(W * 0.3, H - 96, W * 0.4, 3);
    c.restore();
  }

  _radar(g, cx, cy, r) {
    const c = this.ctx, p = g.player;
    const range = 5200;
    c.save();
    c.strokeStyle = 'rgba(140,255,201,0.6)';
    c.lineWidth = 1.5;
    c.beginPath(); c.arc(cx, cy, r, 0, TAU); c.stroke();
    c.strokeStyle = 'rgba(140,255,201,0.25)';
    c.beginPath(); c.arc(cx, cy, r * 0.55, 0, TAU); c.stroke();
    c.beginPath(); c.moveTo(cx - r, cy); c.lineTo(cx + r, cy); c.moveTo(cx, cy - r); c.lineTo(cx, cy + r); c.stroke();

    const h = Math.atan2(p.fwd.x, p.fwd.z);
    const sinH = Math.sin(h), cosH = Math.cos(h);
    const sweepA = (g.time * 1.6) % TAU;
    // 扫描线
    const grd = c.createLinearGradient(cx, cy, cx + Math.sin(sweepA) * r, cy - Math.cos(sweepA) * r);
    grd.addColorStop(0, 'rgba(140,255,201,0.5)');
    grd.addColorStop(1, 'rgba(140,255,201,0)');
    c.strokeStyle = grd;
    c.lineWidth = 2;
    c.beginPath(); c.moveTo(cx, cy);
    c.lineTo(cx + Math.sin(sweepA) * r, cy - Math.cos(sweepA) * r);
    c.stroke();

    const blip = (wx, wz, size, color, shape) => {
      const dx = wx - p.pos.x, dz = wz - p.pos.z;
      const f = dx * sinH + dz * cosH;         // 前向
      const rr = dx * cosH - dz * sinH;        // 右向
      const sx = cx + rr / range * r, sy = cy - f / range * r;
      const dxc = sx - cx, dyc = sy - cy;
      const dc = Math.hypot(dxc, dyc);
      if (dc > r - 3) return;
      const ang = Math.atan2(dxc, -dyc);
      const diff = (sweepA - ang + TAU) % TAU;
      const alpha = 0.25 + 0.75 * (1 - diff / TAU);
      c.globalAlpha = alpha;
      c.fillStyle = color;
      if (shape === 'diamond') {
        c.save(); c.translate(sx, sy); c.rotate(Math.PI / 4);
        c.fillRect(-size, -size, size * 2, size * 2);
        c.restore();
      } else {
        c.fillRect(sx - size, sy - size, size * 2, size * 2);
      }
      c.globalAlpha = 1;
    };

    blip(0, 0, 4, WHITE, 'diamond');                    // 宇宙电梯
    for (const d of g.combat.drones) if (d.alive) blip(d.pos.x, d.pos.z, 3, RED);
    for (const m of g.combat.missiles) if (m.alive) blip(m.mesh.position.x, m.mesh.position.z, 2, AMBER);
    if (g.combat.bird && g.combat.bird.alive) blip(g.combat.bird.pos.x, g.combat.bird.pos.z, 6, RED, 'diamond');
    if (g.combat.groundTargets) {
      for (const gt of g.combat.groundTargets) if (gt.alive) blip(gt.pos.x, gt.pos.z, 4, AMBER, 'diamond');
    }
    if (g.combat.silo) {
      const sp = g.combat.silo.group.position;
      blip(sp.x, sp.z, 5, RED, 'diamond');
    }

    // 玩家（中心三角，朝上）
    c.fillStyle = GREEN;
    c.beginPath();
    c.moveTo(cx, cy - 6); c.lineTo(cx - 5, cy + 5); c.lineTo(cx + 5, cy + 5);
    c.closePath(); c.fill();
    this._t('RADAR', cx, cy + r + 12, 11, DIM, 'center');
    c.restore();
  }

  // 座舱盖雨滴（雨幕/穿云时）
  _droplets(g, dt) {
    const c = this.ctx, W = this.W, H = this.H;
    const inten = Math.max(g.weather.rainIntensity, g.inCloud * 1.2);
    const speedF = clamp(g.player.speed / 500, 0.3, 1.4);
    if (inten > 0.2) {
      const want = Math.floor(inten * 42);
      while (this.drops.length < want) {
        this.drops.push({
          x: Math.random() * W, y: Math.random() * H * 0.5 - 40,
          vx: (Math.random() - 0.5) * 60, vy: 260 + Math.random() * 480,
          life: 0, max: 0.7 + Math.random() * 0.9,
        });
      }
    }
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.life += dt;
      if (d.life > d.max || inten <= 0.1) { this.drops.splice(i, 1); continue; }
      d.x += d.vx * dt * speedF;
      d.y += d.vy * dt * speedF;
      const a = 0.4 * (1 - d.life / d.max) * inten;
      c.strokeStyle = `rgba(205,225,255,${a.toFixed(3)})`;
      c.lineWidth = 1.6;
      c.beginPath();
      c.moveTo(d.x, d.y);
      c.lineTo(d.x - d.vx * 0.035 * speedF, d.y - d.vy * 0.035 * speedF);
      c.stroke();
    }
  }
}
