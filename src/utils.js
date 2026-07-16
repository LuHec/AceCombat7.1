// 工具库：数学、噪声、贴图、拖尾
import * as THREE from 'three';

export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;
// 帧率无关阻尼系数
export const damp = (k, dt) => 1 - Math.exp(-k * dt);
export const rand = (a = 1, b) => b === undefined ? Math.random() * a : a + Math.random() * (b - a);
export const randSpread = s => (Math.random() - 0.5) * s;
export const TAU = Math.PI * 2;

function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
export function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  return lerp(
    lerp(hash2(ix, iy), hash2(ix + 1, iy), ux),
    lerp(hash2(ix, iy + 1), hash2(ix + 1, iy + 1), ux), uy);
}
export function fbm2(x, y, oct = 4) {
  let v = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { v += a * noise2(x * f, y * f); a *= 0.5; f *= 2.03; }
  return v;
}

function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
export function noise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const l = lerp;
  return l(
    l(l(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), ux), l(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), ux), uy),
    l(l(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), ux), l(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), ux), uy),
    uz);
}
export function fbm3(x, y, z, oct = 4) {
  let v = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { v += a * noise3(x * f, y * f, z * f); a *= 0.5; f *= 2.13; }
  return v;
}

// 径向渐变精灵贴图（粒子/光晕用）
export function makeGlowTexture(size, inner, outer) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, inner);
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 尾迹飘带：加色混合 + 顶点色向尾部衰减（尾端黑=不可见）
export class RibbonTrail {
  constructor(scene, maxPoints = 60, brightness = 0.55) {
    this.max = maxPoints;
    this.brightness = brightness;
    this.positions = new Float32Array(maxPoints * 3);
    this.colors = new Float32Array(maxPoints * 3);
    this.points = [];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.mesh = new THREE.Line(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }
  push(p, strength = 1) {
    this.points.push({ x: p.x, y: p.y, z: p.z, s: strength });
    if (this.points.length > this.max) this.points.shift();
    const n = this.points.length;
    for (let i = 0; i < n; i++) {
      const pt = this.points[i];
      this.positions[i * 3] = pt.x; this.positions[i * 3 + 1] = pt.y; this.positions[i * 3 + 2] = pt.z;
      const f = (i / Math.max(1, n - 1)) * this.brightness * pt.s;
      this.colors[i * 3] = f; this.colors[i * 3 + 1] = f; this.colors[i * 3 + 2] = f;
    }
    const geo = this.mesh.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.setDrawRange(0, n);
  }
  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

const _v = new THREE.Vector3();
// 世界坐标 → 屏幕坐标；返回 false 表示在相机背后
export function projectToScreen(pos, camera, w, h, out) {
  _v.copy(pos).project(camera);
  out.x = (_v.x * 0.5 + 0.5) * w;
  out.y = (-_v.y * 0.5 + 0.5) * h;
  out.behind = _v.z > 1;
  return !out.behind;
}
