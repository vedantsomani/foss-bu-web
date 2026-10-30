import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../game/sim.js';
import { WEAPONS, W } from '../game/weapons.js';
import { arena, stepMap, corridor, windowMap, lowCeil, itemArena } from './fixtures.js';

const { BTN, DT } = S;
const inp = o => S.quantizeInput(S.makeInput(o));
function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
function place(world, id, x, y, yaw = 0) {
  const p = world.players[id] || S.addPlayer(world, id);
  p.x = x; p.y = y; p.z = S.floorAt(world.prep, x, y); p.yaw = yaw; p.vx = p.vy = p.vz = 0; p.spawnProt = 0; return p;
}
function run(world, id, ticks, o) { for (let i = 0; i < ticks; i++) S.step(world, { [id]: inp(o) }); }

test('determinism: same seed + inputs -> identical state hash; different seed differs', () => {
  const play = seed => {
    const w = S.createWorld(arena(), seed); [1, 2, 3].forEach(id => S.addPlayer(w, id));
    const r = lcg(99), hashes = [];
    const cur = { 1: {}, 2: {}, 3: {} };
    for (let t = 0; t < 3000; t++) {
      const ins = {};
      for (const id of [1, 2, 3]) {
        if (t % 20 === 0) cur[id] = { fwd: r() * 2 - 1, side: r() * 2 - 1, yaw: r() * 6.28, pitch: (r() - .5) * .4, buttons: (r() < .5 ? BTN.FIRE : 0) | (r() < .1 ? BTN.JUMP : 0) | (r() < .5 ? BTN.SPRINT : 0), weapon: r() < .05 ? 1 + Math.floor(r() * 7) : 0 };
        ins[id] = inp(cur[id]);
      }
      S.step(w, ins);
      if (t % 250 === 0) hashes.push(S.hashWorld(w));
    }
    return { hashes, w };
  };
  const a = play(1234), b = play(1234), c = play(4321);
  assert.deepEqual(a.hashes, b.hashes);
  assert.notEqual(a.hashes.at(-1), c.hashes.at(-1));
  // serialize roundtrip
  const bytes = S.serialize(a.w), w2 = S.deserialize(bytes, a.w.map);
  assert.equal(S.hashWorld(w2), S.hashWorld(a.w));
  // continuing both worlds identically stays identical
  S.step(a.w, {}); S.step(w2, {});
  assert.equal(S.hashWorld(w2), S.hashWorld(a.w));
});

test('movement: accelerates, caps near run speed, friction stops', () => {
  const w = S.createWorld(arena(), 1); const p = place(w, 1, 100, 500);
  run(w, 1, 60, { fwd: 1 });
  assert.ok(Math.abs(Math.hypot(p.vx, p.vy) - S.RUN_SPEED) < 5, 'speed ' + Math.hypot(p.vx, p.vy));
  run(w, 1, 60, { fwd: 0 });
  assert.ok(Math.hypot(p.vx, p.vy) < 1);
  place(w, 1, 20, 500); run(w, 1, 45, { fwd: 1, buttons: BTN.SPRINT });
  assert.ok(Math.hypot(p.vx, p.vy) > S.RUN_SPEED + 50);
});

test('jump: leaves ground, lands, apex ~ 60 units', () => {
  const w = S.createWorld(arena(), 1); const p = place(w, 1, 500, 500);
  let maxz = 0; S.step(w, { 1: inp({ buttons: BTN.JUMP }) });
  for (let i = 0; i < 120; i++) { S.step(w, { 1: inp({}) }); maxz = Math.max(maxz, p.z); }
  assert.ok(maxz > 50 && maxz < 70, 'apex ' + maxz);
  assert.equal(p.z, 0); assert.ok(p.grounded);
});

test('collision: cannot leave a closed room, any heading, at sprint speed, 6000 ticks', () => {
  const w = S.createWorld(arena(), 1); const p = place(w, 1, 512, 512); const r = lcg(7);
  let yaw = 0;
  for (let t = 0; t < 6000; t++) {
    if (t % 15 === 0) yaw = r() * 6.283;
    S.step(w, { 1: inp({ fwd: 1, side: r() < .3 ? 1 : 0, yaw, buttons: BTN.SPRINT | (r() < .02 ? BTN.JUMP : 0) }) });
    assert.ok(p.x >= 15.99 && p.x <= 1024 - 15.99 && p.y >= 15.99 && p.y <= 1024 - 15.99, `escaped at tick ${t}: ${p.x},${p.y}`);
  }
});

test('collision: no tunnelling even with absurd velocity (50 units/tick and 400/tick)', () => {
  for (const v of [3000, 24000]) {
    const w = S.createWorld(arena(), 1); const p = place(w, 1, 900, 500);
    p.vx = v; S.moveCircle(w.prep, p, p.vx * DT, 0);
    assert.ok(p.x <= 1024 - 16 + 0.01, 'x=' + p.x);
    p.vy = -v; S.moveCircle(w.prep, p, 0, p.vy * DT * 3);
    assert.ok(p.y >= 15.99);
  }
});

test('collision: slides along a wall instead of sticking', () => {
  const w = S.createWorld(arena(), 1); const p = place(w, 1, 500, 100, Math.PI * 0.75); // heading -x,+y... into? use diagonal at south wall
  // yaw = -45deg => moves +x and -y into the south wall; should slide along +x
  place(w, 1, 500, 40, -Math.PI / 4);
  run(w, 1, 60, { fwd: 1, yaw: -Math.PI / 4 });
  assert.ok(p.x > 600, 'slid to x=' + p.x); assert.ok(Math.abs(p.y - 16) < 0.5);
});

test('step: 24 climbable, 25 not (walking); stair view smoothing', () => {
  for (const [h, climb] of [[24, true], [25, false], [8, true], [40, false]]) {
    const w = S.createWorld(stepMap(h), 1); const p = place(w, 1, 150, 100, 0);
    run(w, 1, 120, { fwd: 1 });
    if (climb) { assert.ok(p.x > 560, `h=${h} x=${p.x}`); assert.equal(p.z, h); }
    else { assert.ok(p.x < 300 - 15.9, `h=${h} x=${p.x}`); assert.equal(p.z, 0); }
  }
  const w = S.createWorld(stepMap(24), 1); const p = place(w, 1, 150, 100, 0);
  let minOff = 0; for (let i = 0; i < 120; i++) { S.step(w, { 1: inp({ fwd: 1 }) }); minOff = Math.min(minOff, p.stepOff); }
  assert.ok(minOff < -10 && p.stepOff === 0, 'camera offset eased ' + minOff);
});

test('step: jumping gets over a 40-unit ledge; walking down 24 stays grounded', () => {
  const w = S.createWorld(stepMap(40), 1); const p = place(w, 1, 250, 100, 0);
  S.step(w, { 1: inp({ fwd: 1, buttons: BTN.JUMP | BTN.SPRINT }) });
  run(w, 1, 90, { fwd: 1 });
  assert.ok(p.x > 330, 'x=' + p.x); assert.equal(p.z, 40);
  const w2 = S.createWorld(stepMap(24), 1); const q = place(w2, 1, 450, 100, Math.PI);
  q.z = 24; let air = false;
  for (let i = 0; i < 60; i++) { S.step(w2, { 1: inp({ fwd: 1, yaw: Math.PI }) }); if (!q.grounded) air = true; }
  assert.ok(!air && q.z === 0 && q.x < 290);
});

test('two-sided lines: flag 1 blocks players, low ceiling opening blocks, corridor passable', () => {
  let w = S.createWorld(windowMap(), 1); let p = place(w, 1, 100, 100, 0); run(w, 1, 120, { fwd: 1 });
  assert.ok(p.x < 285);
  w = S.createWorld(lowCeil(), 1); p = place(w, 1, 100, 100, 0); run(w, 1, 120, { fwd: 1 });
  assert.ok(p.x < 285, 'low ceiling blocks ' + p.x);
  w = S.createWorld(corridor(), 1); p = place(w, 1, 64, 128, 0); run(w, 1, 200, { fwd: 1 });
  assert.ok(p.x > 700, 'through corridor ' + p.x); assert.ok(p.y > 96 - 0.01 + 16 - 1);
  // corridor is 64 wide: player 32 wide fits, y between 112 and 144
  assert.ok(p.y >= 111.9 && p.y <= 144.1 || p.x > 640);
});

test('sectorAt matches fixture sectors', () => {
  const w = S.createWorld(stepMap(24), 1);
  assert.equal(S.floorAt(w.prep, 100, 100), 0); assert.equal(S.floorAt(w.prep, 400, 100), 24);
  assert.equal(S.floorAt(w.prep, 299, 10), 0); assert.equal(S.floorAt(w.prep, 301, 190), 24);
});

// ---------------------------------------------------------------- weapons
function duel(map = arena()) {
  const w = S.createWorld(map, 5); const a = place(w, 1, 200, 500, 0); const b = place(w, 2, 500, 500, 0);
  return { w, a, b };
}
test('hitscan: hits target ahead, misses when aimed away, blocked by pitch miss and by wall', () => {
  const { w, a, b } = duel();
  S.step(w, { 1: inp({ buttons: BTN.FIRE }) });
  assert.equal(b.health, 100 - w.events.find(e => e.t === 'hit').dmg); assert.ok(b.health < 100);
  assert.equal(a.ammo[0], 49);
  // aim away
  const { w: w2, b: b2 } = duel(); S.step(w2, { 1: inp({ buttons: BTN.FIRE, yaw: 1.0 }) });
  assert.equal(b2.health, 100);
  // pitch up 30deg: over the head at 300 units (eye z=48, rises 173)
  const { w: w3, b: b3 } = duel(); S.step(w3, { 1: inp({ buttons: BTN.FIRE, pitch: 0.5 }) });
  assert.equal(b3.health, 100);
  // pitch toward feet from eye: aimed at target center works with exact angle
  const { w: w4, a: a4, b: b4 } = duel(); b4.z = 0; a4.z = 0; const pitch = Math.atan2(28 - 48, 300);
  S.step(w4, { 1: inp({ buttons: BTN.FIRE, pitch }) }); assert.ok(b4.health < 100);
  // wall between: use the step fixture's flag-1 line? one-sided wall via two rooms
  const w5 = S.createWorld(windowMap(), 1); place(w5, 1, 100, 100); const t = place(w5, 2, 500, 100);
  S.step(w5, { 1: inp({ buttons: BTN.FIRE }) }); assert.ok(t.health < 100, 'bullets pass a flag-1 two-sided window');
  const w6 = S.createWorld(lowCeil(), 1); place(w6, 1, 100, 100); const t6 = place(w6, 2, 500, 100);
  S.step(w6, { 1: inp({ buttons: BTN.FIRE }) }); assert.equal(t6.health, 100, 'low ceiling (40) blocks eye-height (48) bullets');
});

test('shotgun pellets spread; super shotgun hurts more; ammo & cooldown; semi-auto edge', () => {
  const { w, a, b } = duel(); a.owned |= 1 << W.SHOTGUN; a.ammo[1] = 10; a.weapon = W.SHOTGUN; b.x = 330;
  S.step(w, { 1: inp({ buttons: BTN.FIRE }) });
  const hits = w.events.filter(e => e.t === 'hit').length;
  assert.ok(hits >= 3 && hits <= 7, 'pellet hits ' + hits); assert.equal(a.ammo[1], 9);
  assert.equal(a.cooldown, WEAPONS[W.SHOTGUN].cooldown);
  S.step(w, { 1: inp({ buttons: BTN.FIRE }) }); assert.equal(a.ammo[1], 9, 'cooldown/edge prevents refire');
  // chaingun auto-fires while held
  const c = duel(); c.a.owned |= 8; c.a.weapon = W.CHAINGUN; c.a.ammo[0] = 100;
  for (let i = 0; i < 30; i++) S.step(c.w, { 1: inp({ buttons: BTN.FIRE }) });
  assert.equal(c.a.ammo[0], 100 - Math.ceil(30 / 7));
});

test('weapon switching takes time (lower/raise) and is reported', () => {
  const { w, a } = duel(); a.owned |= 1 << W.ROCKET; a.ammo[2] = 5;
  S.step(w, { 1: inp({ weapon: W.ROCKET + 1 }) });
  assert.equal(a.wstate, S.WS.LOWER);
  for (let i = 0; i < 25; i++) S.step(w, { 1: inp({}) });
  assert.equal(a.weapon, W.ROCKET); assert.equal(a.wstate, S.WS.READY);
});

test('rocket: direct flight, wall impact splash decreases with distance, self damage, knockback', () => {
  const w = S.createWorld(arena(), 3);
  const a = place(w, 1, 500, 100, Math.PI / 2); a.owned |= 1 << W.ROCKET; a.weapon = W.ROCKET; a.ammo[2] = 9;
  const near = place(w, 2, 540, 960, 0), far = place(w, 3, 380, 960, 0); // wall at y=1024; near is 64 from wall, far is 120 off in x
  near.y = 990; far.x = 380;
  S.step(w, { 1: inp({ buttons: BTN.FIRE, yaw: Math.PI / 2 }) });
  assert.equal(w.projectiles.length, 1);
  let ex = null; for (let i = 0; i < 120 && !ex; i++) { S.step(w, { 1: inp({ yaw: Math.PI / 2 }) }); ex = w.events.find(e => e.t === 'explode'); }
  assert.ok(ex, 'exploded'); assert.ok(Math.abs(ex.y - 1023) < 3);
  const dn = 100 - near.health, df = 100 - far.health;
  assert.ok(dn > 0 && dn > df, `splash falloff near=${dn} far=${df}`);
  assert.ok(near.vy !== 0 || near.vx !== 0, 'knockback');
  assert.equal(w.projectiles.length, 0);
  // self splash
  const w2 = S.createWorld(arena(), 3); const s = place(w2, 1, 500, 940, Math.PI / 2); s.owned |= 1 << W.ROCKET; s.weapon = W.ROCKET; s.ammo[2] = 3;
  S.step(w2, { 1: inp({ buttons: BTN.FIRE, yaw: Math.PI / 2 }) });
  for (let i = 0; i < 30; i++) S.step(w2, { 1: inp({ yaw: Math.PI / 2 }) });
  assert.ok(s.health < 100, 'rocket jump self-damage ' + s.health);
});

test('rocket direct hit: hits player in flight', () => {
  const { w, a, b } = duel(); a.owned |= 1 << W.ROCKET; a.weapon = W.ROCKET; a.ammo[2] = 3;
  S.step(w, { 1: inp({ buttons: BTN.FIRE }) });
  let hit = null; for (let i = 0; i < 60 && !hit; i++) { S.step(w, { 1: inp({}) }); hit = w.events.find(e => e.t === 'hit' && !e.splash); }
  assert.ok(hit && hit.target === 2); assert.ok(b.health < 100 || !b.alive);
});

test('armor absorbs, kill/frag/respawn with spawn protection', () => {
  const { w, a, b } = duel(); b.armor = 100; b.armorType = 1;
  S.damagePlayer(w, b, 30, 1, 0); assert.equal(b.armor, 90); assert.equal(b.health, 80);
  b.armorType = 2; b.armor = 100; S.damagePlayer(w, b, 20, 1, 0); assert.equal(b.armor, 90); assert.equal(b.health, 70);
  b.armor = 0; S.damagePlayer(w, b, 500, 1, 0);
  assert.ok(!b.alive); assert.equal(a.frags, 1); assert.equal(b.deaths, 1);
  for (let i = 0; i < 179; i++) S.step(w, {});
  assert.ok(!b.alive); S.step(w, {});
  assert.ok(b.alive && b.health === 100 && b.spawnProt > 0);
  assert.ok(w.spawns.some(s => s.x === b.x && s.y === b.y), 'respawned on a deathmatch start');
  const h = b.health; S.damagePlayer(w, b, 50, 1, 0); assert.equal(b.health, h, 'spawn protection');
  for (let i = 0; i < 200; i++) S.step(w, {}); S.damagePlayer(w, b, 50, 1, 0); assert.equal(b.health, 50);
});

test('pickups: weapons/ammo/health/armor collected, then respawn after 30s', () => {
  const w = S.createWorld(itemArena(), 1); assert.equal(w.pickups.length, 5);
  const p = place(w, 1, 250, 128, 0); p.health = 50;
  run(w, 1, 200, { fwd: 1 });
  assert.ok(p.owned & (1 << W.SHOTGUN), 'shotgun'); assert.equal(p.ammo[1], 8);
  assert.equal(p.health, 75); assert.equal(p.armor, 200); assert.equal(p.armorType, 2); assert.equal(p.ammo[2], 1);
  assert.equal(p.ammo[0], 60);
  assert.ok(w.pickups.every(k => !k.active));
  const ev = []; place(w, 1, 100, 900, 0);
  for (let i = 0; i < 1800; i++) { S.step(w, {}); ev.push(...w.events); }
  assert.ok(w.pickups.every(k => k.active), 'all back after 1800 ticks');
  // full health: medikit not consumed
  const p2 = place(w, 1, 399, 128, 0); p2.health = 100; S.step(w, {}); assert.ok(w.pickups[1].active);
});

test('lag-comp hook: hitscan evaluated against rewound positions', () => {
  const { w, a, b } = duel();
  const rewound = { 2: { x: 500, y: 700, z: 0 } }; // where b WAS
  S.step(w, { 1: inp({ buttons: BTN.FIRE }) }, DT, { lagComp: () => rewound });
  assert.equal(b.health, 100, 'b is at 500,500 now but was elsewhere -> miss');
});
