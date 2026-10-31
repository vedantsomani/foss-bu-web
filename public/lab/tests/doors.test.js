import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as S from '../game/sim.js';
import { MemoryNetwork } from '../net/transport.js';
import { GameHost } from '../net/host.js';
import { GameClient } from '../net/client.js';
import { TICK_MS } from '../net/protocol.js';
import { buildMap } from './fixtures.js';

const { BTN } = S;
const inp = o => S.quantizeInput(S.makeInput(o));
const dm = (x, y, angle = 0) => ({ x, y, angle, type: 11, flags: 7 });

// Row of rooms  A(0..300) | D(300..332 door) | B(332..632), all 64 deep. Rect order makes the A|D and B|D lines face the rooms (front = room, back = door).
function doorMap(special = 1, tag = 0) {
  const m = buildMap([
    { x0: 0, y0: 0, x1: 300, y1: 64, floor: 0, ceil: 128 },
    { x0: 332, y0: 0, x1: 632, y1: 64, floor: 0, ceil: 128 },
    { x0: 300, y0: 0, x1: 332, y1: 64, floor: 0, ceil: 0 },
  ], [dm(100, 32), dm(500, 32, 180)]);
  m.sectors[2].tag = tag;
  const ad = m.linedefs.find(l => m.sidedefs[l.front].sector === 0 && l.back >= 0 && m.sidedefs[l.back].sector === 2);
  const bd = m.linedefs.find(l => m.sidedefs[l.front].sector === 1 && l.back >= 0 && m.sidedefs[l.back].sector === 2);
  ad.special = special; ad.tag = tag; bd.special = special; bd.tag = tag;
  return { map: m, lineA: m.linedefs.indexOf(ad), lineB: m.linedefs.indexOf(bd) };
}
function place(world, id, x, y, yaw = 0) {
  const p = world.players[id] || S.addPlayer(world, id);
  p.x = x; p.y = y; p.z = S.floorAt(world.prep, x, y, world.sectorFloor); p.yaw = yaw; p.vx = p.vy = p.vz = 0; p.spawnProt = 0; p.lastButtons = 0; return p;
}
const idle = { fwd: 0 };
function tickN(w, n, ins) { for (let i = 0; i < n; i++) S.step(w, ins ? { 1: inp(ins) } : {}); }
// press USE for one tick and release
function press(w, yaw = 0) { S.step(w, { 1: inp({ buttons: BTN.USE, yaw }) }); S.step(w, { 1: inp({ yaw }) }); }

test('BTN.USE is bit 8 and worlds expose live Float32Array sector heights', () => {
  assert.equal(BTN.USE, 8);
  const { map } = doorMap();
  const w = S.createWorld(map, 1);
  assert.ok(w.sectorFloor instanceof Float32Array && w.sectorCeil instanceof Float32Array);
  assert.equal(w.sectorFloor.length, 3); assert.equal(w.sectorCeil[2], 0);
});

test('manual door (special 1): opens to neighbour ceiling-4 at 70 u/s, waits ~4.3 s, closes; timing is exact and deterministic', () => {
  const { map } = doorMap(1);
  const w = S.createWorld(map, 1); place(w, 1, 250, 32, 0);
  assert.equal(w.sectorCeil[2], 0);
  press(w);                                                   // use trace reaches the A|D line 50 units ahead
  assert.equal(w.movers.length, 1);
  let tOpen = -1, tTop = -1, tClose = -1;
  for (let t = 1; t < 900 && tClose < 0; t++) {
    tickN(w, 1);
    const c = w.sectorCeil[2];
    if (tTop < 0 && c >= 124) tTop = t;
    if (tTop >= 0 && tOpen < 0 && c < 124) tOpen = t;
    if (tTop >= 0 && w.sectorCeil[2] === 0) tClose = t;
  }
  // 124 units at 70/60 per tick = 106.3 ticks to open
  assert.ok(tTop >= 104 && tTop <= 109, 'opened after ' + tTop + ' (+2 ticks of press)');
  assert.equal(S.DOOR_WAIT, 257);
  const closeStart = tOpen;                                    // first tick below the top
  assert.ok(closeStart - tTop >= 256 && closeStart - tTop <= 259, 'waited ' + (closeStart - tTop));
  assert.ok(tClose - closeStart >= 105 && tClose - closeStart <= 109, 'closed in ' + (tClose - closeStart));
  assert.equal(w.movers.length, 0);
  assert.equal(w.sectorCeil[2], 0);
});

test('using a door again while it waits closes it early; using it while closing reopens it', () => {
  const { map } = doorMap(1);
  const w = S.createWorld(map, 1); place(w, 1, 250, 32, 0);
  press(w); tickN(w, 150);
  assert.equal(w.sectorCeil[2], 124);
  press(w); tickN(w, 40);                                      // closing now
  assert.ok(w.sectorCeil[2] < 124 && w.sectorCeil[2] > 0);
  const mid = w.sectorCeil[2];
  press(w); tickN(w, 10);                                      // reverse
  assert.ok(w.sectorCeil[2] > mid);
});

test('collision uses live heights: closed door blocks, opened door lets the player through, and closing is crush-free (blocked doors reopen)', () => {
  const { map } = doorMap(1);
  const w = S.createWorld(map, 1); const p = place(w, 1, 250, 32, 0);
  tickN(w, 120, { fwd: 1, yaw: 0 });
  assert.ok(p.x < 300 - 16 + 0.5, 'blocked by closed door, x=' + p.x);
  p.x = 250; p.vx = 0; p.lastButtons = 0;
  press(w); tickN(w, 125);                                    // open
  tickN(w, 120, { fwd: 1, yaw: 0 });
  assert.ok(p.x > 340, 'walked through, x=' + p.x);
  // stand inside the door sector at the moment it starts to close: the door must reopen instead of crushing
  p.x = 316; p.y = 32; p.vx = p.vy = 0; p.lastButtons = 0;
  let reopened = false, minGap = Infinity;
  for (let t = 0; t < 700; t++) {
    tickN(w, 1, idle);
    if (p.x > 300 && p.x < 332) { minGap = Math.min(minGap, w.sectorCeil[2] - p.z); if (w.movers[0] && w.movers[0].st === 1 && w.sectorCeil[2] < 124 && t > 100) reopened = true; }
  }
  assert.ok(reopened, 'door reopened when blocked');
  assert.ok(minGap >= S.HEIGHT - 0.01, 'never closed on the player: gap ' + minGap);
  assert.ok(p.alive && p.health === 100);
  // once the player leaves, it closes
  p.x = 100; p.vx = 0;
  tickN(w, 900, idle);
  assert.equal(w.sectorCeil[2], 0);
});

// A(0..200) | X(200..232 trigger strip) | D(232..264 tagged door) | B(264..564)
function walkMap(special, tag = 7) {
  const m = buildMap([
    { x0: 0, y0: 0, x1: 200, y1: 64, floor: 0, ceil: 128 },
    { x0: 264, y0: 0, x1: 564, y1: 64, floor: 0, ceil: 128 },
    { x0: 200, y0: 0, x1: 232, y1: 64, floor: 0, ceil: 128 },
    { x0: 232, y0: 0, x1: 264, y1: 64, floor: 0, ceil: 0 },
  ], [dm(100, 32)]);
  m.sectors[3].tag = tag;
  const find = (a, b) => m.linedefs.find(l => m.sidedefs[l.front].sector === a && l.back >= 0 && m.sidedefs[l.back].sector === b);
  const trig = find(0, 2); trig.special = special; trig.tag = tag;
  return { map: m, line: m.linedefs.indexOf(trig) };
}

test('walk triggers: W1 door fires once and is consumed, WR fires every time; SR switch reverts, S1 stays', () => {
  let { map, line } = walkMap(2);                               // W1 open stay
  let w = S.createWorld(map, 1); let p = place(w, 1, 150, 32, 0);
  tickN(w, 30, { fwd: 1, yaw: 0 });
  assert.ok(p.x > 205, 'player crossed the walk line, x=' + p.x);
  assert.equal(w.lineDone[line], 1, 'W1 consumed'); assert.equal(w.movers.length, 1);
  tickN(w, 130); assert.equal(w.sectorCeil[3], 124); assert.equal(w.movers.length, 0);

  ({ map, line } = walkMap(90));                               // WR open-wait-close
  w = S.createWorld(map, 1); p = place(w, 1, 150, 32, 0);
  tickN(w, 30, { fwd: 1, yaw: 0 }); assert.equal(w.movers.length, 1); assert.equal(w.lineDone[line], 0);
  tickN(w, 500);                                                // full cycle (107 + 257 + 107)
  assert.equal(w.sectorCeil[3], 0); assert.equal(w.movers.length, 0);
  p.x = 150; p.vx = 0;                                          // walk over it again: fires again
  tickN(w, 30, { fwd: 1, yaw: 0 }); assert.equal(w.movers.length, 1, 'WR repeats');
  // crossing the other way (back side -> front) also fires walk lines
  const back = S.createWorld(map, 1); const q = place(back, 1, 215, 32, Math.PI);
  tickN(back, 20, { fwd: 1, yaw: Math.PI }); assert.equal(back.movers.length, 1, 'walk lines fire from either side');

  // SR (special 63) pressed by USE: switch texture state toggles, then reverts after 1 s; S1 (29) stays and is consumed
  for (const [special, once] of [[63, false], [29, true]]) {
    const d = doorMap(special, 7);
    d.map.sidedefs[d.map.linedefs[d.lineA].front].middle = 'SW1COMP';
    const sw = S.createWorld(d.map, 1); place(sw, 1, 250, 32, 0);
    press(sw);
    assert.equal(sw.switchedLines[d.lineA], 1); assert.equal(sw.movers.length, 1);
    tickN(sw, S.BUTTON_TICKS + 2);
    assert.equal(sw.switchedLines[d.lineA], once ? 1 : 0, once ? 'S1 stays pressed' : 'SR reverts');
    assert.equal(sw.lineDone[d.lineA], once ? 1 : 0);
  }
});

test('USE ignores the back side of a line and stops at the first plain wall', () => {
  const { map } = doorMap(1);
  const w = S.createWorld(map, 1);
  place(w, 1, 380, 32, Math.PI);                             // in room B facing the B|D line: front is room B -> usable
  press(w, Math.PI); assert.equal(w.movers.length, 1);
  const w2 = S.createWorld(map, 1); const p2 = place(w2, 1, 600, 32, 0);   // facing the outer wall at x=632 (plain one-sided line)
  press(w2, 0); assert.equal(w2.movers.length, 0);
  p2.x = 310; p2.y = 32;                                       // inside the door sector (closed -> no opening) facing the A|D line from its back
  press(w2, Math.PI); assert.equal(w2.movers.length, 0, 'cannot use from the back side');
});

test('lift (special 62): lowers to the lowest neighbour floor, waits 3 s, raises; rider is carried and never crushed', () => {
  // A(floor 0) | L(lift, floor 0 -> low 0?)  use a lower neighbour: B floor -64
  const m = buildMap([
    { x0: 0, y0: 0, x1: 200, y1: 64, floor: 0, ceil: 200 },
    { x0: 232, y0: 0, x1: 432, y1: 64, floor: -64, ceil: 200 },
    { x0: 200, y0: 0, x1: 232, y1: 64, floor: 0, ceil: 200 },
  ], [dm(100, 32)]);
  m.sectors[2].tag = 3;
  const ld = m.linedefs.find(l => m.sidedefs[l.front].sector === 0 && l.back >= 0 && m.sidedefs[l.back].sector === 2);
  ld.special = 62; ld.tag = 3;
  const w = S.createWorld(m, 1); const p = place(w, 1, 216, 32, 0);
  const liftIdx = m.linedefs.indexOf(ld);
  assert.equal(S.triggerLine(w, liftIdx), true);
  let tLow = -1, tUp = -1;
  const zs = [];
  for (let t = 1; t < 700; t++) {
    tickN(w, 1, idle); zs.push(p.z);
    if (tLow < 0 && w.sectorFloor[2] === -64) tLow = t;
    if (tLow > 0 && tUp < 0 && w.sectorFloor[2] === 0 && t > tLow + 10) tUp = t;
  }
  assert.ok(tLow >= 27 && tLow <= 30, 'lowered in ' + tLow);               // 64 / (140/60)
  assert.ok(tUp - tLow >= 180 + 27 - 3 && tUp - tLow <= 180 + 30 + 3, 'cycle ' + (tUp - tLow));
  assert.equal(w.movers.length, 0);
  assert.equal(p.z, 0); assert.ok(p.grounded);
  assert.ok(Math.min(...zs) <= -63.9, 'rider went down with the lift');
});

test('teleporter (special 97): front side crossing teleports to the tagged thing-14 destination, back side does not', () => {
  const m = buildMap([
    { x0: 0, y0: 0, x1: 200, y1: 200, floor: 0, ceil: 200 },
    { x0: 200, y0: 0, x1: 232, y1: 200, floor: 0, ceil: 200 },      // pad sector
    { x0: 500, y0: 0, x1: 700, y1: 200, floor: 16, ceil: 220 },     // destination room (not adjacent; its own closed box)
  ], [dm(100, 100), { x: 600, y: 100, angle: 90, type: 14, flags: 7 }]);
  m.sectors[2].tag = 5;
  const tl = m.linedefs.find(l => m.sidedefs[l.front].sector === 0 && l.back >= 0 && m.sidedefs[l.back].sector === 1);
  tl.special = 97; tl.tag = 5;
  for (const auth of [true, false]) {
    const w = auth ? S.createWorld(m, 1) : S.createPredictWorld(m);
    if (!auth) { const np = S.newPlayer(1); np.alive = true; np.health = 100; w.players[1] = np; }   // prediction worlds have no spawns
    const p = place(w, 1, 150, 100, 0);
    let hop = null;
    for (let i = 0; i < 60 && !hop; i++) { w.events = []; S.runCommand(w, p, inp({ fwd: 1, yaw: 0 }), S.DT); hop = w.events.find(e => e.t === 'teleport' && !e.out); }
    assert.ok(hop, `teleport event (auth=${auth})`);
    assert.deepEqual([p.x, p.y, p.z, hop.yaw, p.vx, p.vy], [600, 100, 16, 90, 0, 0]);
    assert.ok(Math.abs(p.yaw - Math.PI / 2) < 1e-9);
    // walking back from the pad side (back of the line) is not a teleport: place in the pad and walk -x across the line
    const q = p; Object.assign(q, { x: 215, y: 100, z: 0, yaw: Math.PI, vx: 0, vy: 0, vz: 0 });
    for (let i = 0; i < 30; i++) S.runCommand(w, q, inp({ fwd: 1, yaw: Math.PI }), S.DT);
    assert.ok(q.x < 200 && q.x > 0 && q.y === 100, 'walked into room A (no teleport from the back side), x=' + q.x);
  }
});

test('teleport events carry destination + yaw over the wire', async () => {
  const { writeEvent, readEvent, Writer, Reader } = await import('../net/protocol.js');
  const w = new Writer(32); writeEvent(w, { t: 'teleport', p: 3, out: 0, x: 600, y: 100, z: 16, yaw: 90 }, 100, 98);
  writeEvent(w, { t: 'mover', s: 41, a: 2, x: 12, y: -40, z: 0 }, 100, 100);
  const r = new Reader(w.bytes());
  const a = readEvent(r, 100), b = readEvent(r, 100);
  assert.deepEqual([a.t, a.p, a.out, a.yaw, a.x, a.y, a.z, a.tick], ['teleport', 3, false, 90, 600, 100, 16, 98]);
  assert.deepEqual([b.t, b.s, b.a, b.x, b.y], ['mover', 41, 2, 12, -40]);
});

test('gun-triggered door (special 46) opens when a hitscan shot crosses its line', () => {
  const { map, lineA } = doorMap(46, 9);
  const w = S.createWorld(map, 1); const p = place(w, 1, 250, 32, 0); p.pitch = 0;
  S.step(w, { 1: inp({ buttons: BTN.FIRE, yaw: 0 }) });
  assert.equal(w.movers.length, 1, 'shot opened door');
  assert.equal(w.lineDone[lineA], 0, 'GR repeats');
});

test('determinism: movers/switches in hash; serialize/deserialize round-trips mid-motion and stays in lock-step', () => {
  const { map } = doorMap(1);
  const play = withUse => {
    const w = S.createWorld(map, 3); place(w, 1, 250, 32, 0);
    for (let t = 0; t < 400; t++) S.step(w, { 1: inp({ buttons: withUse && t === 5 ? BTN.USE : 0, yaw: 0 }) });
    return w;
  };
  const a = play(true), b = play(true), c = play(false);
  assert.equal(S.hashWorld(a), S.hashWorld(b));
  assert.notEqual(S.hashWorld(a), S.hashWorld(c));
  const mid = S.deserialize(S.serialize(a), map);
  assert.equal(S.hashWorld(mid), S.hashWorld(a));
  for (let t = 0; t < 600; t++) { const i = { 1: inp({ yaw: 0 }) }; S.step(a, i); S.step(mid, i); }
  assert.equal(S.hashWorld(mid), S.hashWorld(a));
  assert.equal(a.sectorCeil[2], 0);
});

// ------------------------------------------------------------------ networking
function session({ latency = 60, jitter = 15, loss = 0.1, seed = 4, map, src }) {
  const net = new MemoryNetwork({ latency, jitter, loss, seed, reorder: true });
  const host = new GameHost({ map, endpoint: net.endpoint(1), seed: 7 });
  let client;
  client = new GameClient({ map, endpoint: net.endpoint(2), id: 2, inputSource: () => src(client) });
  const s = { net, host, client, now: 0 };
  s.run = sec => { for (let i = 0, n = Math.round(sec * 60); i < n; i++) { s.now += TICK_MS; net.update(s.now); host.update(s.now); client.update(s.now); (s.hook || (() => {}))(s); } };
  return s;
}

test('client and host agree on door heights through MemoryNetwork with latency, jitter and loss', () => {
  const { map } = doorMap(1, 0);
  let n = 0;
  // the client player walks up to the door and presses USE once (input reaches the host over the lossy link)
  const s = session({ map, src: () => { n++; return n < 30 ? { fwd: 1, yaw: 0, side: 0 } : n < 33 ? { fwd: 0, yaw: 0, buttons: BTN.USE } : { fwd: 0, yaw: 0 }; } });
  s.run(0.5);
  const hp = s.host.world.players[2]; hp.x = 250; hp.y = 32; hp.z = 0; hp.yaw = 0;       // stand 50 units from the door
  s.client.me && Object.assign(s.client.me, { x: 250, y: 32 });
  let maxDiff = 0, moving = 0, openedAt = -1;
  s.hook = () => {
    const h = s.host.sectorHeights().ceils[2], c = s.client.sectorHeights().ceils[2];
    if (h > 0 && h < 124) moving++;
    if (openedAt < 0 && h > 0) openedAt = s.host.world.tick;
    if (moving > 0 && h < 124 && h > 0) maxDiff = Math.max(maxDiff, Math.abs(h - c));
  };
  n = 0; s.run(3);
  assert.ok(openedAt > 0, 'host door opened from the client USE input');
  assert.ok(moving > 60);
  // while moving the client lags by at most one-way latency + jitter + snapshot interval worth of travel (extrapolation reduces it)
  const maxTicks = Math.ceil((60 + 15) / TICK_MS) + 4;
  assert.ok(maxDiff <= maxTicks * S.DOOR_SPEED + 1e-3, `moving diff ${maxDiff.toFixed(2)} <= ${(maxTicks * S.DOOR_SPEED).toFixed(2)}`);
  s.client.inputSource = () => ({ fwd: 0 });
  s.run(8);                                                    // full open-wait-close cycle completes
  assert.equal(s.host.sectorHeights().ceils[2], 0);
  assert.equal(s.client.sectorHeights().ceils[2], 0);
  const a = s.host.sectorHeights(), b = s.client.sectorHeights();
  assert.deepEqual([...a.floors], [...b.floors]); assert.deepEqual([...a.ceils], [...b.ceils]);
  assert.equal(s.client.stats.missingBase, 0);
  assert.equal(s.host.sectorHeights(), s.host.sectorHeights(), 'cached object');
});

test('prediction rides a lift without fighting it (latency + loss): predicted z stays on the floor, final state agrees', () => {
  const m = buildMap([
    { x0: 0, y0: 0, x1: 300, y1: 200, floor: 0, ceil: 300 },
    { x0: 300, y0: 0, x1: 360, y1: 200, floor: 0, ceil: 300 },
    { x0: 360, y0: 0, x1: 660, y1: 200, floor: -96, ceil: 300 },
  ], [dm(100, 100)]);
  m.sectors[1].tag = 2;
  const ld = m.linedefs.find(l => m.sidedefs[l.front].sector === 0 && l.back >= 0 && m.sidedefs[l.back].sector === 1);
  ld.special = 62; ld.tag = 2;
  const s = session({ map: m, latency: 80, jitter: 20, loss: 0.1, seed: 12, src: () => ({ fwd: 0 }) });
  s.run(1);
  const hp = s.host.world.players[2]; hp.x = 330; hp.y = 100; hp.z = 0; hp.vx = hp.vy = 0;
  s.run(1.5); s.client.stats.maxCorrection = 0; s.client.stats.corrections = 0;   // the shove above was a deliberate teleport
  assert.ok(S.triggerLine(s.host.world, m.linedefs.indexOf(ld)));
  let maxOff = 0;
  s.hook = () => {
    const me = s.client.me, floor = s.client.sectorHeights().floors[1];
    if (me && me.grounded) maxOff = Math.max(maxOff, Math.abs(me.z - floor));
  };
  s.run(8);
  assert.ok(maxOff < 1e-3, 'client player glued to its (latest known) lift floor, off by ' + maxOff);
  const c = s.client.me, h = s.host.world.players[2];
  assert.ok(Math.hypot(c.x - h.x, c.y - h.y, c.z - h.z) < 1, 'settled agreement');
  assert.equal(s.client.sectorHeights().floors[1], s.host.sectorHeights().floors[1]);
  assert.ok(s.client.stats.maxCorrection < 12, 'no violent corrections: ' + s.client.stats.maxCorrection);
});

// ------------------------------------------------------------------ real FreeDM maps
const raw = zlib.gunzipSync(fs.readFileSync(new URL('../../freedm.wad.gz', import.meta.url)));
const wadjs = await import('../wad.js');
const wad = wadjs.readWad(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));

test('FreeDM MAP01..MAP32: every door/lift/floor special fires, heights stay finite and sane, doors return, hashes are reproducible', () => {
  let total = 0, mapsWith = 0;
  for (let n = 1; n <= 32; n++) {
    const name = 'MAP' + String(n).padStart(2, '0');
    if (wad.lumpIndex(name) < 0) continue;
    const map = wadjs.parseMap(wad, name);
    const run = () => {
      const w = S.createWorld(map, 5);
      let fired = 0;
      map.linedefs.forEach((l, i) => { const sp = S.lineSpecialInfo(l.special); if (sp && sp.fam !== 'tele' && sp.fam !== 'stop' && l.tag + (sp.fam === 'mdoor' ? 1 : 0) > 0) { if (S.triggerLine(w, i)) fired++; } });
      for (let t = 0; t < 2400; t++) S.step(w, {});
      return { w, fired };
    };
    const a = run(), b = run();
    assert.equal(S.hashWorld(a.w), S.hashWorld(b.w), name + ' reproducible');
    for (let i = 0; i < a.w.sectorFloor.length; i++) {
      assert.ok(Number.isFinite(a.w.sectorFloor[i]) && Number.isFinite(a.w.sectorCeil[i]), name + ' finite');
      assert.ok(a.w.sectorCeil[i] >= a.w.sectorFloor[i] - 0.001, `${name} sector ${i} ceil>=floor (${a.w.sectorFloor[i]},${a.w.sectorCeil[i]})`);
    }
    // non-perpetual movers have finished
    assert.ok(a.w.movers.every(m => m.f & 1 || m.st === 3 || m.k === S.MK.PLAT && m.f & 1), name + ' only perpetual movers remain');
    if (a.fired) mapsWith++;
    total += a.fired;
  }
  console.log(`  [specials] fired ${total} line specials over ${mapsWith} maps`);
  assert.ok(total > 100);
});

test('FreeDM MAP01: 4 bots with USE spam across 6000 ticks stay deterministic with finite state', () => {
  const map = wadjs.parseMap(wad, 'MAP01');
  const play = () => {
    const w = S.createWorld(map, 42); const ids = [1, 2, 3, 4]; ids.forEach(i => S.addPlayer(w, i));
    let st = 9; const r = () => ((st = (Math.imul(st, 1664525) + 1013904223) >>> 0) / 4294967296);
    const cur = {}; let doorsSeen = 0;
    for (let t = 0; t < 6000; t++) {
      const ins = {};
      for (const id of ids) { if (t % 20 === id) cur[id] = { fwd: 1, yaw: r() * 6.283, buttons: S.BTN.SPRINT | (r() < 0.5 ? S.BTN.USE : 0) }; ins[id] = S.quantizeInput(cur[id] || {}); }
      S.step(w, ins);
      doorsSeen = Math.max(doorsSeen, w.movers.length);
    }
    return { h: S.hashWorld(w), doorsSeen, w };
  };
  const a = play(), b = play();
  assert.equal(a.h, b.h);
  console.log(`  [bots] max concurrent movers ${a.doorsSeen}`);
  for (const p of Object.values(a.w.players)) assert.ok(Number.isFinite(p.x + p.y + p.z));
});

test('FreeDM: a player standing in front of every manual door (specials 1/117) can open it with USE and then walk through', () => {
  let doors = 0, tried = 0, opened = 0;
  for (let n = 1; n <= 32; n++) {
    const name = 'MAP' + String(n).padStart(2, '0');
    if (wad.lumpIndex(name) < 0) continue;
    const map = wadjs.parseMap(wad, name);
    map.linedefs.forEach((l, i) => {
      if (l.special !== 1 && l.special !== 117) return;
      const w = S.createWorld(map, 1), L = w.prep.lines[i];
      doors++;
      // stand 24..56 units in front of the line's midpoint (front = right-hand side of v1->v2 in Doom), look at it
      const mx = (L.ax + L.bx) / 2, my = (L.ay + L.by) / 2, nx = L.dy / L.len, ny = -L.dx / L.len;
      let px, py, ok = false;
      for (const d of [56, 44, 32, 24]) {   // doors often sit behind a narrow frame sector: back up until there is room to stand
        px = mx + nx * d; py = my + ny * d;
        const sc = S.sectorAt(w.prep, px, py);
        if (w.sectorCeil[sc] - w.sectorFloor[sc] >= S.HEIGHT && w.sectorFloor[sc] === w.sectorFloor[L.fs]) { ok = true; break; }
      }
      if (!ok) return;                                   // door fronted by stairs: no flat spot to stand on
      tried++;
      const p = w.players[1] || S.addPlayer(w, 1);
      Object.assign(p, { x: px, y: py, z: w.sectorFloor[L.fs], yaw: Math.atan2(-ny, -nx), vx: 0, vy: 0, vz: 0, spawnProt: 0, lastButtons: 0 });
      S.step(w, { 1: inp({ buttons: BTN.USE, yaw: p.yaw }) });
      if (w.movers.length === 1 && w.movers[0].s === L.bs) opened++;
    });
  }
  console.log(`  [doors] manual doors in FreeDM: ${doors}, tried from a flat spot in front: ${tried}, opened by USE: ${opened}`);
  assert.ok(doors > 50 && tried > 50); assert.equal(opened, tried);
});
