// 程序化机体建模：三架战机 / MQ-101 无人机 / 军械巨鸟(Arsenal Bird) / 导弹
import * as THREE from 'three';

export const AIRCRAFT = {
  f16: {
    id: 'f16', name: 'F-16C', role: 'FIGHTING FALCON · 轻型高机动',
    maxSpeed: 615, accel: 58, pitch: 1.6, roll: 3.8, yaw: 0.6, msl: 48, hp: 100,
    color: 0x93a3b8, stats: { SPEED: 3, MOBILITY: 5, STABILITY: 3, FIREPOWER: 3 },
  },
  f22: {
    id: 'f22', name: 'F-22A', role: 'RAPTOR · 制空隐身猛禽',
    maxSpeed: 715, accel: 64, pitch: 1.5, roll: 3.3, yaw: 0.52, msl: 64, hp: 110,
    color: 0x5f666e, stats: { SPEED: 5, MOBILITY: 4, STABILITY: 4, FIREPOWER: 4 },
  },
  su57: {
    id: 'su57', name: 'Su-57', role: 'FELON · 重型超机动',
    maxSpeed: 675, accel: 60, pitch: 1.8, roll: 3.0, yaw: 0.62, msl: 56, hp: 120,
    color: 0x7c8ba6, stats: { SPEED: 4, MOBILITY: 5, STABILITY: 3, FIREPOWER: 5 },
  },
};

// ---- 共享材质 ----
const MAT = {
  canopy: new THREE.MeshStandardMaterial({ color: 0x1a2836, metalness: 0.95, roughness: 0.12 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x23262b, metalness: 0.6, roughness: 0.5 }),
  nozzle: new THREE.MeshStandardMaterial({ color: 0x494f55, metalness: 0.9, roughness: 0.35 }),
  burner: new THREE.MeshBasicMaterial({ color: 0xffa030, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
  missile: new THREE.MeshStandardMaterial({ color: 0xd8dce2, metalness: 0.4, roughness: 0.4 }),
  flame: new THREE.MeshBasicMaterial({ color: 0xffc060, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
};

export function bodyMat(color) {
  return new THREE.MeshStandardMaterial({ color, metalness: 0.72, roughness: 0.34 });
}

// 梯形翼面（半翼，根部在原点，向 +X 伸展，前缘朝 +Z）
function wingGeo(span, rootChord, tipChord, thick, sweep) {
  const rc = rootChord / 2, tc = tipChord / 2, t = thick / 2;
  const A = [0, -t, rc], B = [0, -t, -rc], C = [span, -t, tc - sweep], D = [span, -t, -tc - sweep];
  const E = [0, t, rc], F = [0, t, -rc], G = [span, t, tc - sweep], H = [span, t, -tc - sweep];
  const tris = [
    E, G, F, F, G, H,      // 上
    A, B, C, B, D, C,      // 下
    E, A, G, A, C, G,      // 前缘
    F, H, B, B, H, D,      // 后缘
    G, C, H, C, D, H,      // 翼尖
  ];
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(tris.length * 3);
  tris.forEach((v, i) => pos.set(v, i * 3));
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}
function coneZ(r, len, mat, x = 0, y = 0, z = 0, flip = false) {
  const g = new THREE.ConeGeometry(r, len, 10);
  g.rotateX(flip ? -Math.PI / 2 : Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  return m;
}
function cylZ(r, len, mat, x = 0, y = 0, z = 0, rSeg = 10) {
  const g = new THREE.CylinderGeometry(r, r, len, rSeg);
  g.rotateX(Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  return m;
}
function canopyMesh(sx, sy, sz, x, y, z) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), MAT.canopy);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  return m;
}
function burner(x, y, z, r = 0.55, len = 3.4) {
  const g = new THREE.ConeGeometry(r, len, 8);
  g.rotateX(-Math.PI / 2); // 指向 -Z（尾喷方向）
  const m = new THREE.Mesh(g, MAT.burner.clone());
  m.position.set(x, y, z - len / 2);
  m.visible = false;
  return m;
}
function navLight(color, x, y, z, r = 0.14) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 6, 5),
    new THREE.MeshBasicMaterial({ color }));
  m.position.set(x, y, z);
  return m;
}

// ---- 战机（机头朝 +Z）----
export function buildAircraft(def) {
  const g = new THREE.Group();
  const bm = bodyMat(def.color);
  const burners = [];
  let wingtips, gunPos;

  if (def.id === 'f22') {
    g.add(box(3.0, 1.15, 12.5, bm, 0, 0, -0.6));                 // 机身
    g.add(coneZ(0.85, 4.6, bm, 0, -0.05, 7.6));                  // 机头锥
    g.children.at(-1).scale.y = 0.62;
    g.add(canopyMesh(0.62, 0.5, 1.7, 0, 0.72, 3.4));
    for (const s of [-1, 1]) {
      const w = new THREE.Mesh(wingGeo(5.4, 6.2, 1.9, 0.28, 3.1), bm);   // 主翼
      if (s < 0) w.scale.x = -1;
      w.position.set(s * 1.2, -0.1, -0.5);
      g.add(w);
      const st = new THREE.Mesh(wingGeo(2.9, 3.1, 1.2, 0.2, 1.7), bm);   // 平尾
      if (s < 0) st.scale.x = -1;
      st.position.set(s * 1.1, -0.05, -5.6);
      g.add(st);
      const vt = box(0.18, 2.6, 3.4, bm, s * 2.1, 1.15, -4.9);           // 外倾垂尾
      vt.rotation.z = -s * 0.5;
      g.add(vt);
      g.add(cylZ(0.78, 3.6, MAT.nozzle, s * 1.05, 0.05, -6.4));          // 发动机舱
      const b = burner(s * 1.05, 0.05, -8.2, 0.66, 4.2);
      burners.push(b); g.add(b);
      g.add(box(1.4, 0.5, 5, bm, s * 1.9, 0.15, 1.6));                   // 进气道
    }
    g.add(navLight(0xff2222, -6.6, 0, -1.8), navLight(0x22ff44, 6.6, 0, -1.8));
    wingtips = [new THREE.Vector3(-6.6, 0, -1.8), new THREE.Vector3(6.6, 0, -1.8)];
    gunPos = new THREE.Vector3(0.8, 0.4, 4);
  } else if (def.id === 'su57') {
    g.add(box(4.4, 0.95, 13.5, bm, 0, 0.1, -0.4));                // 宽扁机身
    g.add(coneZ(0.8, 5.2, bm, 0, 0.05, 8.6));
    g.children.at(-1).scale.set(1.4, 0.55, 1);
    g.add(canopyMesh(0.6, 0.5, 1.8, 0, 0.75, 3.8));
    for (const s of [-1, 1]) {
      const w = new THREE.Mesh(wingGeo(5.0, 6.6, 1.7, 0.26, 3.6), bm);
      if (s < 0) w.scale.x = -1;
      w.position.set(s * 1.7, 0, -0.6);
      g.add(w);
      const st = new THREE.Mesh(wingGeo(2.7, 3.4, 1.1, 0.18, 2.0), bm);
      if (s < 0) st.scale.x = -1;
      st.position.set(s * 2.2, 0.1, -6.0);
      g.add(st);
      const vt = box(0.18, 2.4, 3.6, bm, s * 3.1, 1.3, -4.6);
      vt.rotation.z = -s * 0.62;
      g.add(vt);
      g.add(cylZ(0.85, 7.5, bm, s * 1.6, -0.28, -3.4));           // 宽间距发动机
      g.add(cylZ(0.7, 2.6, MAT.nozzle, s * 1.6, -0.28, -7.9));
      const b = burner(s * 1.6, -0.28, -9.2, 0.6, 4.4);
      burners.push(b); g.add(b);
      const lv = new THREE.Mesh(wingGeo(2.2, 3.0, 1.0, 0.16, 1.4), bm);  // 前缘边条
      if (s < 0) lv.scale.x = -1;
      lv.position.set(s * 1.4, 0.28, 2.6);
      g.add(lv);
    }
    g.add(navLight(0xff2222, -6.7, 0, -1.6), navLight(0x22ff44, 6.7, 0, -1.6));
    wingtips = [new THREE.Vector3(-6.7, 0, -1.6), new THREE.Vector3(6.7, 0, -1.6)];
    gunPos = new THREE.Vector3(1.2, 0.5, 4.4);
  } else { // f16
    g.add(box(1.9, 1.35, 10.5, bm, 0, 0, -0.3));
    g.add(coneZ(0.72, 3.8, bm, 0, 0, 7.0));
    g.children.at(-1).scale.y = 0.8;
    g.add(canopyMesh(0.55, 0.55, 1.55, 0, 0.85, 3.1));
    for (const s of [-1, 1]) {
      const w = new THREE.Mesh(wingGeo(4.3, 4.6, 1.3, 0.24, 2.4), bm);
      if (s < 0) w.scale.x = -1;
      w.position.set(s * 0.9, -0.25, -1.4);
      g.add(w);
      const st = new THREE.Mesh(wingGeo(2.2, 2.6, 0.9, 0.16, 1.3), bm);
      if (s < 0) st.scale.x = -1;
      st.position.set(s * 0.8, -0.15, -5.0);
      g.add(st);
      const vf = box(0.14, 1.1, 2.0, bm, s * 0.55, -1.0, -4.4);   // 腹鳍
      vf.rotation.z = s * 0.35;
      g.add(vf);
    }
    const vt = box(0.16, 2.7, 3.2, bm, 0, 1.35, -4.4);            // 单垂尾
    vt.rotation.x = 0.18;
    g.add(vt);
    g.add(cylZ(0.72, 3.2, MAT.nozzle, 0, 0, -5.8));
    const b = burner(0, 0, -7.4, 0.62, 4.0);
    burners.push(b); g.add(b);
    g.add(box(1.5, 0.6, 3.4, bm, 0, -0.75, 1.8));                 // 腹部进气道
    g.add(navLight(0xff2222, -5.2, -0.2, -2.2), navLight(0x22ff44, 5.2, -0.2, -2.2));
    wingtips = [new THREE.Vector3(-5.2, -0.2, -2.2), new THREE.Vector3(5.2, -0.2, -2.2)];
    gunPos = new THREE.Vector3(0.6, 0.3, 3.6);
  }

  // 翼下挂架导弹（装饰）
  for (const s of [-1, 1]) {
    const p = cylZ(0.12, 2.6, MAT.missile, s * 2.6, -0.55, -1.2, 6);
    g.add(p);
  }

  g.traverse(o => { if (o.isMesh) o.castShadow = false; });
  return { group: g, burners, wingtips, gunPos, def };
}

// ---- MQ-101 无人机（飞翼）----
export function buildDrone() {
  const g = new THREE.Group();
  const bm = bodyMat(0x3d434c);
  for (const s of [-1, 1]) {
    const w = new THREE.Mesh(wingGeo(4.6, 4.4, 1.0, 0.3, 2.6), bm);
    if (s < 0) w.scale.x = -1;
    g.add(w);
  }
  g.add(box(1.3, 0.8, 5.2, bm, 0, 0.1, -0.4));
  g.add(cylZ(0.55, 1.8, MAT.nozzle, 0, 0.25, -2.6));
  const b = burner(0, 0.25, -3.5, 0.42, 2.2);
  b.visible = true; b.material.opacity = 0.55;
  g.add(b);
  const eye = navLight(0xff3020, 0, 0.35, 1.6, 0.2);
  g.add(eye);
  return { group: g, burner: b, eye };
}

// ---- 军械巨鸟 Arsenal Bird（巨型飞翼，翼展 ~240m）----
export function buildArsenalBird() {
  const g = new THREE.Group();
  const bm = bodyMat(0x9aa0a8);
  const bmDark = bodyMat(0x6e747c);
  const props = [];

  for (const s of [-1, 1]) {
    const w = new THREE.Mesh(wingGeo(112, 62, 26, 7, 18), bm);
    if (s < 0) w.scale.x = -1;
    w.position.set(s * 8, 0, 10);
    g.add(w);
    // 外段上反角小翼
    const tip = box(2, 14, 16, bmDark, s * 118, 7, -8);
    g.add(tip);
  }
  g.add(box(26, 11, 95, bm, 0, 0, 0));                 // 中央机体
  g.add(coneZ(9, 26, bm, 0, -1, 58));
  g.children.at(-1).scale.y = 0.7;
  g.add(box(14, 5, 40, bmDark, 0, -7.5, -12));         // 机腹舱段
  g.add(box(48, 3.5, 20, bmDark, 0, 6.5, -32));        // 背部脊

  // 8 具螺旋桨（前缘）
  const bladeMat = new THREE.MeshBasicMaterial({ color: 0x30343a, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  const discMat = new THREE.MeshBasicMaterial({ color: 0xcccccc, transparent: true, opacity: 0.10, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  for (let i = 0; i < 8; i++) {
    const s = i < 4 ? -1 : 1;
    const k = (i % 4) / 3;                    // 0..1
    const x = s * (26 + k * 82);
    const nac = cylZ(2.6, 10, bmDark, x, 0, 34);
    g.add(nac);
    const rotor = new THREE.Group();
    rotor.position.set(x, 0, 40);
    for (let bI = 0; bI < 3; bI++) {
      const blade = box(1.1, 11, 0.3, bladeMat);
      blade.rotation.z = bI * Math.PI / 3;
      rotor.add(blade);
    }
    const disc = new THREE.Mesh(new THREE.CircleGeometry(6.2, 20), discMat);
    rotor.add(disc);
    g.add(rotor);
    props.push(rotor);
  }

  // 航行灯 / 信标
  const beacons = [];
  const bpos = [[-118, 2, -8, 0xff2222], [118, 2, -8, 0x22ff44], [0, 9, -44, 0xffffff], [0, -10, -12, 0xff8833]];
  for (const [x, y, z, c] of bpos) {
    const b = navLight(c, x, y, z, 1.1);
    g.add(b); beacons.push(b);
  }
  return { group: g, props, beacons };
}

// ---- 敌方战斗机（第二关）----
export const ENEMY_DEF = {
  id: 'su57', name: 'SU-57', role: 'ENEMY FIGHTER',
  maxSpeed: 640, accel: 55, pitch: 1.5, roll: 3.0, yaw: 0.55, msl: 999, hp: 3,
  color: 0x49505c, stats: {},
};

// ---- SAM 防空导弹设施 ----
export function buildSAMSite() {
  const g = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 0.9 });
  const military = new THREE.MeshStandardMaterial({ color: 0x5a6350, roughness: 0.7, metalness: 0.3 });

  const pad = new THREE.Mesh(new THREE.CylinderGeometry(13, 14, 2.5, 10), concrete);
  pad.position.y = 1;
  g.add(pad);
  g.add(box(8, 4, 6, concrete, -4, 4, 0));                        // 掩体
  const dish = new THREE.Group();                                  // 旋转雷达
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 7, 6), military);
  pole.position.y = 3.5;
  dish.add(pole);
  const ant = new THREE.Mesh(new THREE.SphereGeometry(3.2, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.4), military);
  ant.position.y = 7;
  ant.rotation.x = Math.PI / 3.2;
  dish.add(ant);
  dish.position.set(5, 0, -3);
  g.add(dish);
  for (const s of [-1, 1]) {                                       // 导弹发射架
    const rack = box(3.2, 1.2, 5.5, military, 2 + s * 4.5, 3.2, 4);
    g.add(rack);
    for (let i = 0; i < 4; i++) {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 5.2, 6), MAT.dark);
      tube.rotation.x = Math.PI / 2.6;
      tube.position.set(2 + s * 4.5 - 1.2 + i * 0.8, 4.4, 4);
      g.add(tube);
    }
  }
  const beacon = navLight(0xff3524, -4, 7.5, 0, 0.35);
  g.add(beacon);
  return { group: g, dish, beacon };
}

// ---- 地井 + 巨炮（第二关决战）----
export function buildSilo() {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x9aa2ac, metalness: 0.8, roughness: 0.4 });
  const metalD = new THREE.MeshStandardMaterial({ color: 0x5d646d, metalness: 0.75, roughness: 0.5 });

  // 井缘
  const rim = new THREE.Mesh(new THREE.TorusGeometry(150, 7, 10, 40), metalD);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 2;
  g.add(rim);
  // 8 扇圆形地面门
  const doors = [];
  for (let i = 0; i < 8; i++) {
    const wedge = new THREE.Mesh(new THREE.CylinderGeometry(148, 148, 9, 6, 1, false, i * Math.PI / 4, Math.PI / 4 * 0.97), metal);
    wedge.position.y = 0;
    g.add(wedge);
    const mid = i * Math.PI / 4 + Math.PI / 8;
    doors.push({ mesh: wedge, dir: new THREE.Vector3(Math.cos(mid), 0, Math.sin(mid)) });
  }
  // 井筒（黑）
  const hole = new THREE.Mesh(new THREE.CylinderGeometry(146, 146, 140, 24, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 1, side: THREE.BackSide }));
  hole.position.y = -70;
  g.add(hole);
  const bottom = new THREE.Mesh(new THREE.CircleGeometry(146, 24), new THREE.MeshBasicMaterial({ color: 0x0a0c10 }));
  bottom.rotation.x = -Math.PI / 2;
  bottom.position.y = -139;
  g.add(bottom);

  // 升降平台 + 巨炮
  const platform = new THREE.Group();
  platform.position.y = -118;
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(132, 132, 16, 24), metalD);
  platform.add(deck);
  const turret = new THREE.Group();                                // 可旋转炮塔
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(20, 24, 20, 12), metal);
  ped.position.y = 18;
  turret.add(ped);
  turret.add(box(44, 16, 44, metalD, 0, 10, 0));
  const breech = box(22, 18, 26, metal, 0, 30, -14);
  turret.add(breech);
  const barrelG = new THREE.Group();                               // 炮管（俯仰）
  barrelG.position.set(0, 32, 0);
  barrelG.rotation.x = -Math.PI / 3.4;                             // 仰角 ~53°
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 6.5, 125, 12), metal);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.z = 55;
  barrelG.add(barrel);
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(6.8, 1.4, 8, 14), metalD);
    ring.position.z = 30 + i * 28;
    barrelG.add(ring);
  }
  const core = new THREE.Mesh(new THREE.SphereGeometry(6.5, 14, 12),
    new THREE.MeshBasicMaterial({ color: 0x66e8ff }));
  core.position.z = -2;
  barrelG.add(core);
  turret.add(barrelG);
  platform.add(turret);
  // 平台警示灯
  const beacons = [];
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    const b = navLight(0xff5030, Math.cos(a) * 120, 9, Math.sin(a) * 120, 1.2);
    platform.add(b);
    beacons.push(b);
  }
  g.add(platform);
  return { group: g, doors, platform, turret, barrelG, core, beacons };
}
export function buildMissile() {
  const g = new THREE.Group();
  g.add(cylZ(0.16, 2.4, MAT.missile, 0, 0, 0, 8));
  g.add(coneZ(0.16, 0.6, MAT.dark, 0, 0, 1.5));
  for (let i = 0; i < 4; i++) {
    const f = box(0.5, 0.05, 0.5, MAT.dark, 0, 0, -1.0);
    f.rotation.z = i * Math.PI / 2;
    f.position.set(Math.cos(i * Math.PI / 2) * 0.24, Math.sin(i * Math.PI / 2) * 0.24, -1.0);
    g.add(f);
  }
  const flame = coneZ(0.2, 1.6, MAT.flame, 0, 0, -1.8, true);
  g.add(flame);
  return g;
}
