// 无头仿真：复现 M2 发导弹卡死（不渲染，只跑逻辑帧）
// 最小 DOM 桩（canvas 2D 贴图）
globalThis.document = {
  createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({
      createRadialGradient: () => ({ addColorStop: () => {} }),
      fillRect: () => {},
      set fillStyle(v) {},
    }),
  }),
};
globalThis.window = { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, addEventListener: () => {} };
globalThis.performance = globalThis.performance || { now: () => Date.now() };

const THREE = await import('../libs/three.module.js');
const { World } = await import('../src/world.js');
const { Player } = await import('../src/flight.js');
const { CombatManager } = await import('../src/combat.js');
const { AIRCRAFT } = await import('../src/models.js');

const scene = new THREE.Scene();
const audioStub = new Proxy({}, { get: () => () => {} });
const world = new World(scene);
world.setMission(2);
const player = new Player(scene, AIRCRAFT.f16);
player.mouseRef = { x: 0, y: 0 };
const events = {
  onKill: () => {}, onPhase: () => {}, onStage: () => {},
  onPlayerHit: () => {}, onWin: () => console.log('WIN'), onLose: () => console.log('LOSE'),
};
const combat = new CombatManager(scene, world, player, audioStub, events, 2);

const keys = {};
const dt = 1 / 60;
let maxFrame = 0, maxAt = '';
let hits = 0, shook = 0;
const origHit = events.onPlayerHit;
events.onPlayerHit = () => { hits++; origHit(); };
const origKill = events.onKill;
events.onKill = (msg) => { if (msg.includes('甩开')) shook++; origKill(msg); };
for (let i = 0; i < 3600; i++) {           // 60 秒仿真
  const t0 = performance.now();
  if (i === 600) { for (const g of combat.groundTargets) { g.alive = false; } }
  // 每 12s 从玩家尾后 1200m 发射一枚敌导弹，测试甩脱
  if (i > 120 && i % 720 === 0) {
    const back = player.fwd.clone().multiplyScalar(-1200).add(player.pos);
    back.y = player.pos.y;
    combat.enemyFire({ pos: back, fwd: player.fwd.clone(), speed: 420, alive: true });
  }
  if (combat.lock.locked && i % 30 === 0) combat.playerFire();
  // 敌导弹逼近时持续急转（模拟玩家防御机动）
  player.mouseRef.x = combat.incomingAlarm ? 0.9 : 0.2;
  player.mouseRef.y = combat.incomingAlarm ? -0.6 : 0;
  combat.update(dt, keys, false);
  combat.effects.update(dt);
  player.update(dt, keys, world);
  const ms = performance.now() - t0;
  if (ms > maxFrame) {
    maxFrame = ms;
    maxAt = `frame=${i} missiles=${combat.missiles.length} drones=${combat.drones.filter(d => d.alive).length} stage=${combat.stage} cannonHp=${combat.silo.cannon.hp.toFixed(0)} allyHp=${combat.allyBird ? combat.allyBird.hp.toFixed(0) : '-'}`;
  }
  if (ms > 100) console.log('SLOW FRAME', ms.toFixed(1) + 'ms', 'at', i, 'missiles=', combat.missiles.length);
  if (i % 600 === 0) console.log(`t=${(i / 60).toFixed(0)}s stage=${combat.stage} silo=${combat.silo.state} drones=${combat.drones.filter(d => d.alive).length} missiles=${combat.missiles.length} parts=${combat.effects.parts.length} cannonHp=${combat.silo.cannon.hp} allyHp=${combat.allyBird.hp.toFixed(0)} playerHp=${player.hp} 被命中=${hits} 甩开=${shook}`);
}
console.log('DONE maxFrame=', maxFrame.toFixed(1) + 'ms', maxAt, `被命中=${hits} 甩开=${shook}`);
