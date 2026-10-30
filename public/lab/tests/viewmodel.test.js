import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as V from '../game/viewmodel.js';
import { loadWeaponSprites, weaponLumpNames } from '../game/sprites.js';
import { SPRITE_FRAMES, WEAPONS } from '../game/weapons.js';

const base = { speed: 0, grounded: true, sprint: false, lookDX: 0, lookDY: 0, weapon: 0, wstate: 0, wtimer: 0, events: [], player: { x: 100, y: 200, z: 0, yaw: 0, pitch: 0 } };
const run = (vm, sec, ctx, dt = 1 / 60) => { let pose; for (let i = 0; i < Math.round(sec / dt); i++) pose = V.updateViewModel(vm, dt, ctx); return pose; };

test('spring converges and is stable at large dt', () => {
  let p = 10, v = 0; [p, v] = V.spring(p, v, 0, 140, 11, 2); assert.ok(Math.abs(p) < 0.01 && Math.abs(v) < 0.1);
});
test('idle: no bob, pose at rest; walking bobs with speed-dependent amplitude; stride locked to distance', () => {
  const vm = V.createViewModel(); const rest = run(vm, 1, base);
  assert.ok(Math.abs(rest.x) < 1e-6 && Math.abs(rest.y) < 1e-6);
  const range = speed => { const v = V.createViewModel(); let mn = 1e9, mx = -1e9; run(v, 1, { ...base, speed }); for (let i = 0; i < 120; i++) { const p = V.updateViewModel(v, 1 / 60, { ...base, speed }); mn = Math.min(mn, p.y); mx = Math.max(mx, p.y); } return mx - mn; };
  assert.ok(range(420) > 1.5); assert.ok(range(420) > range(150) * 1.5);
  const air = V.createViewModel(); run(air, 1, { ...base, speed: 420, grounded: false }); assert.ok(Math.abs(V.computePose(air).y) < 0.5);
});
test('mouse sway follows look velocity and recovers', () => {
  const vm = V.createViewModel(); let maxX = 0;
  for (let i = 0; i < 20; i++) maxX = Math.max(maxX, Math.abs(V.updateViewModel(vm, 1 / 60, { ...base, lookDX: 0.03 }).x));
  assert.ok(maxX > 3 && maxX <= 16.5); const after = run(vm, 1, base); assert.ok(Math.abs(after.x) < 0.05);
});
test('landing dip: dips down then recovers; harder landing = bigger dip', () => {
  const dip = v => { const vm = V.createViewModel(); V.updateViewModel(vm, 1 / 60, { ...base, events: [{ t: 'land', v }] }); let mx = 0; for (let i = 0; i < 90; i++) mx = Math.max(mx, V.updateViewModel(vm, 1 / 60, base).y); return [mx, vm.land]; };
  const [soft] = dip(300), [hard, end] = dip(900);
  assert.ok(hard > soft && hard > 5); assert.ok(Math.abs(end) < 0.05);
});
test('recoil: kick on fire, recovers within 0.6 s; heavier weapon kicks more; camera kick exposed', () => {
  const kick = w => { const vm = V.createViewModel(); let mx = 0, cam = 0; V.updateViewModel(vm, 1 / 60, { ...base, weapon: w, events: [{ t: 'fire' }] }); for (let i = 0; i < 40; i++) { const p = V.updateViewModel(vm, 1 / 60, { ...base, weapon: w }); mx = Math.max(mx, p.y); cam = Math.max(cam, p.camPitch); } run(vm, 0.6, { ...base, weapon: w }); return { mx, cam, rest: Math.abs(vm.kick) + Math.abs(vm.camKick) }; };
  const pis = kick(0), ssg = kick(2);
  assert.ok(pis.mx > 3 && ssg.mx > pis.mx * 1.5 && ssg.cam > pis.cam); assert.ok(pis.rest < 0.05 && ssg.rest < 0.05);
});
test('fire emits exactly one {type:"muzzle",x,y,z} event in front of the eye; flash window follows weapon data', () => {
  const vm = V.createViewModel();
  const pose = V.updateViewModel(vm, 1 / 60, { ...base, player: { x: 100, y: 200, z: 0, yaw: Math.PI / 2, pitch: 0 }, events: [{ t: 'fire' }] });
  const ev = V.drainViewEvents(vm); assert.equal(ev.length, 1); assert.equal(ev[0].type, 'muzzle');
  assert.ok(Math.abs(ev[0].y - 224) < 0.01 && Math.abs(ev[0].z - 43) < 0.01 && Math.abs(ev[0].x - 107) < 0.01, JSON.stringify(ev[0]));
  assert.equal(V.drainViewEvents(vm).length, 0);
  assert.equal(pose.flashLump, 'PISFA0');
  const later = run(vm, WEAPONS[0].flashTicks / 60 + 0.05, base); assert.equal(later.flashLump, null);
});
test('fire animation walks the gun frames and returns to the idle frame', () => {
  for (const w of [0, 1, 2, 3, 4, 5, 6]) {
    const vm = V.createViewModel(); const seen = new Set();
    V.updateViewModel(vm, 1 / 60, { ...base, weapon: w, events: [{ t: 'fire' }] });
    for (let i = 0; i < WEAPONS[w].cooldown + 30; i++) seen.add(V.updateViewModel(vm, 1 / 60, { ...base, weapon: w }).gunLump);
    assert.ok(seen.size >= (w === 3 ? 1 : 2), 'weapon ' + w + ' frames ' + [...seen]);
    assert.equal(V.computePose(vm).gunLump, SPRITE_FRAMES[w].gun[0]);
  }
});
test('lower/raise drops the weapon off-screen and back (driven by sim wstate/wtimer)', () => {
  const vm = V.createViewModel(); const ys = [];
  for (let t = 10; t >= 0; t--) ys.push(V.updateViewModel(vm, 1 / 60, { ...base, wstate: 1, wtimer: t }).y);
  for (let t = 10; t >= 0; t--) ys.push(V.updateViewModel(vm, 1 / 60, { ...base, weapon: 1, wstate: 2, wtimer: t }).y);
  const mid = ys[10]; assert.ok(mid > 100, 'fully lowered ' + mid); assert.ok(ys[0] < 5 && ys.at(-1) < 5);
  for (let i = 1; i <= 10; i++) assert.ok(ys[i] >= ys[i - 1] - 1e-9); for (let i = 12; i < 22; i++) assert.ok(ys[i] <= ys[i - 1] + 1e-9);
});
test('pure: identical inputs give identical poses', () => {
  const go = () => { const vm = V.createViewModel(); let p; for (let i = 0; i < 300; i++) p = V.updateViewModel(vm, 1 / 60, { ...base, speed: 300, lookDX: Math.sin(i / 9) * 0.01, events: i % 50 === 0 ? [{ t: 'fire' }] : [] }); return JSON.stringify(p); };
  assert.equal(go(), go());
});
test('FreeDM sprites decode from the WAD (PLAYPAL + Doom picture format)', () => {
  const gz = new URL('../../freedm.wad.gz', import.meta.url);
  const b = zlib.gunzipSync(fs.readFileSync(gz));
  const sp = loadWeaponSprites(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  for (const n of weaponLumpNames()) assert.ok(sp[n], 'missing ' + n);
  const pg = sp.PISGA0; assert.equal(pg.width, 82); assert.equal(pg.height, 92);
  const opaque = pg.rgba.reduce((a, v, i) => a + (i % 4 === 3 && v === 255 ? 1 : 0), 0);
  assert.ok(opaque > 1500 && opaque < 82 * 92, 'opaque px ' + opaque);
});
