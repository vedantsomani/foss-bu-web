// Aiming regressions: shots must follow the view pitch through height changes (ledges, pits, doorways), and
// explosions must not hurt through walls.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../game/sim.js';
import { W } from '../game/weapons.js';
import { buildMap } from './fixtures.js';

const { BTN } = S;
const inp = o => S.quantizeInput(S.makeInput(o));
const dm = (x, y) => ({ x, y, angle: 0, type: 11, flags: 7 });
function place(world, id, x, y, yaw = 0) {
  const p = world.players[id] || S.addPlayer(world, id);
  p.x = x; p.y = y; p.z = S.floorAt(world.prep, x, y, world.sectorFloor); p.yaw = yaw; p.vx = p.vy = p.vz = 0; p.spawnProt = 0; return p;
}
const pitchTo = (a, b, dist) => Math.atan2(b.z + 28 - (a.z + S.EYE), dist);

test('hitscan: aiming down off a ledge hits a target on the lower floor (origin sector floor must not block the ray)', () => {
  const m = buildMap([{ x0: 0, y0: 0, x1: 300, y1: 200, floor: 128, ceil: 400 }, { x0: 300, y0: 0, x1: 900, y1: 200, floor: 0, ceil: 400 }], [dm(100, 100), dm(700, 100)]);
  const w = S.createWorld(m, 1);
  const a = place(w, 1, 250, 100, 0), b = place(w, 2, 600, 100, 0);
  S.step(w, { 1: inp({ buttons: BTN.FIRE, pitch: pitchTo(a, b, 350) }) });
  assert.ok(b.health < 100, 'target below the ledge was hit');
  assert.ok(w.events.some(e => e.t === 'hit' && e.target === 2));
  // and a shot that is too steep-down for the target lands on the lower floor instead (floor of the *target* sector still blocks)
  const w2 = S.createWorld(m, 1); const a2 = place(w2, 1, 250, 100, 0), b2 = place(w2, 2, 800, 100, 0);
  S.step(w2, { 1: inp({ buttons: BTN.FIRE, pitch: -0.5 }) });
  const imp = w2.events.find(e => e.t === 'impact'); assert.ok(imp && Math.abs(imp.z) < 2 && imp.x > 300 && imp.x < 800, 'impact on the lower floor: ' + JSON.stringify(imp));
  assert.equal(b2.health, 100); assert.equal(a2.health, 100);
});

test('hitscan: aiming up out of a low-ceiling room hits a target on a raised platform beyond the doorway', () => {
  const m = buildMap([{ x0: 0, y0: 0, x1: 300, y1: 200, ceil: 100 }, { x0: 300, y0: 0, x1: 600, y1: 200, ceil: 600 }, { x0: 600, y0: 0, x1: 900, y1: 200, floor: 96, ceil: 600 }],
    [dm(100, 100), dm(800, 100)]);
  const w = S.createWorld(m, 1);
  const a = place(w, 1, 250, 100, 0), b = place(w, 2, 800, 100, 0);
  S.step(w, { 1: inp({ buttons: BTN.FIRE, pitch: pitchTo(a, b, 550) }) });
  assert.ok(b.health < 100, 'target hit through the taller room');
  // the low ceiling still stops a shot aimed steeply into it
  const w2 = S.createWorld(m, 1); const a2 = place(w2, 1, 100, 100, 0), b2 = place(w2, 2, 800, 100, 0);
  S.step(w2, { 1: inp({ buttons: BTN.FIRE, pitch: 0.4 }) });
  const imp = w2.events.find(e => e.t === 'impact'); assert.ok(imp && imp.z <= 100.01 && imp.x < 300, 'ceiling impact inside the low room: ' + JSON.stringify(imp));
  assert.equal(b2.health, 100); assert.ok(a2);
});

test('hitscan: looking straight down / up never throws and hits floor / ceiling', () => {
  const m = buildMap([{ x0: 0, y0: 0, x1: 400, y1: 400, ceil: 200 }], [dm(100, 100)]);
  for (const pitch of [-1.5, 1.5]) {
    const w = S.createWorld(m, 1); place(w, 1, 200, 200);
    S.step(w, { 1: inp({ buttons: BTN.FIRE, pitch }) });
    const imp = w.events.find(e => e.t === 'impact'); assert.ok(imp, 'impact for pitch ' + pitch);
    assert.ok(pitch < 0 ? imp.z < 1 : imp.z > 199, `z ${imp.z}`);
  }
});

test('rocket aimed at the floor in front of you explodes on the floor (self damage) at any pitch down', () => {
  const m = buildMap([{ x0: 0, y0: 0, x1: 1024, y1: 1024 }], [dm(100, 100)]);
  const w = S.createWorld(m, 1); const a = place(w, 1, 500, 500); a.owned |= 1 << W.ROCKET; a.weapon = W.ROCKET; a.ammo[2] = 5;
  S.step(w, { 1: inp({ buttons: BTN.FIRE, pitch: -1.2 }) });
  let ex = null; for (let i = 0; i < 60 && !ex; i++) { S.step(w, { 1: inp({ pitch: -1.2 }) }); ex = w.events.find(e => e.t === 'explode'); }
  assert.ok(ex && ex.z < 3, 'exploded on the floor'); assert.ok(a.health < 100, 'splash hurt the shooter');
});

test('splash: explosions do not hurt players on the far side of a wall; same-room splash still does', () => {
  // two rooms separated by a 16-unit void (solid wall); rocket hits the near face, victim stands right behind it
  const m = buildMap([{ x0: 0, y0: 0, x1: 300, y1: 200 }, { x0: 316, y0: 0, x1: 700, y1: 200 }], [dm(100, 100), dm(500, 100)]);
  const w = S.createWorld(m, 1); const a = place(w, 1, 150, 100, 0); a.owned |= 1 << W.ROCKET; a.weapon = W.ROCKET; a.ammo[2] = 5;
  const v = place(w, 2, 340, 100, 0);
  S.step(w, { 1: inp({ buttons: BTN.FIRE }) });
  let ex = null; for (let i = 0; i < 60 && !ex; i++) { S.step(w, { 1: inp({}) }); ex = w.events.find(e => e.t === 'explode'); }
  assert.ok(ex && ex.x < 300 + 0.5, 'rocket hit the near wall face');
  assert.equal(v.health, 100, 'no damage through the wall');
  const w2 = S.createWorld(m, 1); const a2 = place(w2, 1, 150, 100, 0); a2.owned |= 1 << W.ROCKET; a2.weapon = W.ROCKET; a2.ammo[2] = 5;
  const v2 = place(w2, 2, 270, 100, 0); v2.y = 140;   // same room, beside the impact point
  S.step(w2, { 1: inp({ buttons: BTN.FIRE }) });
  for (let i = 0; i < 60; i++) S.step(w2, { 1: inp({}) });
  assert.ok(v2.health < 100, 'splash still hurts in the open');
});

test('weapon: holding fire with an empty gun falls back to a weapon that has ammo', () => {
  const m = buildMap([{ x0: 0, y0: 0, x1: 400, y1: 400 }], [dm(100, 100)]);
  const w = S.createWorld(m, 1); const a = place(w, 1, 200, 200);
  a.owned |= (1 << W.CHAINGUN); a.weapon = W.CHAINGUN; a.ammo[0] = 3;
  for (let i = 0; i < 60; i++) S.step(w, { 1: inp({ buttons: BTN.FIRE }) });   // fire is held the whole time
  assert.equal(a.ammo[0], 0);
  a.owned |= 1 << W.SHOTGUN; a.ammo[1] = 5;
  for (let i = 0; i < 60; i++) S.step(w, { 1: inp({ buttons: BTN.FIRE }) });
  assert.equal(a.weapon, W.SHOTGUN, 'switched away from the empty chaingun');
  S.step(w, { 1: inp({}) }); S.step(w, { 1: inp({ buttons: BTN.FIRE }) });   // semi-auto: needs a fresh press
  assert.ok(a.ammo[1] < 5, 'and can shoot it');
});

test('corpses obey gravity (no hanging in mid-air), slide to a stop from knockback and stay on rising floors', () => {
  const m = buildMap([{ x0: 0, y0: 0, x1: 600, y1: 400, ceil: 600 }], [dm(100, 100)]);
  const w = S.createWorld(m, 1); const a = place(w, 1, 300, 200); a.z = 200; a.grounded = false;   // killed while in the air
  a.alive = false; a.health = 0; a.respawn = 180;
  for (let i = 0; i < 90; i++) S.step(w, {});
  assert.ok(a.z === 0 && a.grounded, 'corpse fell to the floor: z=' + a.z);
  a.vx = 400; a.vy = 0;
  for (let i = 0; i < 40; i++) S.step(w, {});
  assert.ok(a.x > 300 && Math.abs(a.vx) < 1, 'slid and stopped: x=' + a.x + ' vx=' + a.vx);
  assert.ok(a.x < 590, 'and stayed inside the room');
  // a lift raising the floor carries the corpse instead of burying it
  w.sectorFloor[0] = 30; S.step(w, {});
  assert.equal(a.z, 30);
});
