import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryNetwork } from '../net/transport.js';
import { GameHost } from '../net/host.js';
import { GameClient } from '../net/client.js';
import { TICK_MS } from '../net/protocol.js';
import * as S from '../game/sim.js';
import { W } from '../game/weapons.js';
import { arena } from './fixtures.js';

// Deterministic virtual-time session: one host (uid 1, not a player) + N clients.
function session({ latency = 0, jitter = 0, loss = 0, seed = 1, maxRewindMs = 200, map = arena(), sources = {}, snapshotEvery = 2, reorder = true } = {}) {
  const net = new MemoryNetwork({ latency, jitter, loss, seed, reorder });
  const host = new GameHost({ map, endpoint: net.endpoint(1), seed: 7, maxRewindMs, snapshotEvery });
  const clients = {};
  for (const id of Object.keys(sources).map(Number)) clients[id] = new GameClient({ map, endpoint: net.endpoint(id), id, inputSource: () => sources[id](clients[id]) });
  const s = { net, host, clients, now: 0, frames: 0, hooks: [] };
  s.frame = () => { s.now += TICK_MS; net.update(s.now); host.update(s.now); for (const c of Object.values(clients)) c.update(s.now); s.frames++; for (const h of s.hooks) h(s); };
  s.run = sec => { const n = Math.round(sec * 60); for (let i = 0; i < n; i++) s.frame(); };
  return s;
}
// scripted wandering input: changes heading/strafe/jump every ~0.5s, deterministic
function wander(seed) {
  let st = seed >>> 0, cur = { fwd: 1, side: 0, yaw: 0, buttons: 0 }, n = 0;
  const r = () => ((st = (Math.imul(st, 1664525) + 1013904223) >>> 0) / 4294967296);
  return () => {
    if (n++ % 30 === 0) cur = { fwd: r() < .85 ? 1 : -1, side: r() < .4 ? (r() < .5 ? -1 : 1) : 0, yaw: r() * 6.283, pitch: 0, buttons: (r() < .3 ? S.BTN.JUMP : 0) | (r() < .5 ? S.BTN.SPRINT : 0) };
    return { ...cur, buttons: cur.buttons & ~(n % 30 === 1 ? 0 : S.BTN.JUMP) };
  };
}

test('handshake + snapshots flow; host world never waits (keeps ticking with a dead client)', () => {
  const s = session({ latency: 40, sources: { 2: () => ({ fwd: 1 }), 3: () => ({}) } });
  s.run(2);
  assert.ok(s.clients[2].ready && s.clients[3].ready);
  assert.ok(s.clients[2].stats.snapshots > 40);
  // kill client 3's connection entirely: host tick rate must not change
  s.clients[3].update = () => {}; s.net.setLink(3, 1, { loss: 1 }); s.net.setLink(1, 3, { loss: 1 });
  const t0 = s.host.world.tick; s.run(3);
  assert.equal(s.host.world.tick - t0, 180);
  assert.ok(s.clients[2].stats.snapshots > 100);
});

test('prediction+reconciliation: 150 ms one-way latency, 30 ms jitter, 5% loss, reordering', () => {
  const src = wander(5);
  const s = session({ latency: 150, jitter: 30, loss: 0.05, seed: 3, sources: { 2: src } });
  // record predicted-vs-authoritative at each executed command
  const predLog = new Map(), hostLog = new Map();
  const c = s.clients[2];
  const origTick = c.tick.bind(c);
  c.tick = () => { origTick(); if (c.me) predLog.set(c.me.lastSeq, { x: c.me.x, y: c.me.y, z: c.me.z }); };
  const origHost = s.host.tick.bind(s.host);
  s.host.tick = () => { origHost(); const p = s.host.world.players[2], peer = s.host.peers.get(2); if (p && peer) hostLog.set(peer.lastExec, { x: p.x, y: p.y, z: p.z }); };
  s.run(25);
  let n = 0, big = 0, max = 0, sum = 0;
  for (const [seq, h] of hostLog) { const p = predLog.get(seq); if (!p || seq < 30) continue; const e = Math.hypot(p.x - h.x, p.y - h.y, p.z - h.z); n++; sum += e; max = Math.max(max, e); if (e > 1) big++; }
  console.log(`  [prediction] compared=${n} mean=${(sum / n).toFixed(4)} max=${max.toFixed(3)} >1u=${big} corrections=${c.stats.corrections} maxCorr=${c.stats.maxCorrection.toFixed(2)} skippedCmds=${s.host.stats.skippedCommands} net loss=${s.net.stats.dropped}/${s.net.stats.sent}`);
  assert.ok(n > 1000);
  assert.ok(big / n < 0.02, 'fraction of commands whose prediction differed >1u: ' + big / n);
  // settle: stop input, let everything drain, then predicted must equal authoritative within 1 unit
  c.inputSource = () => ({ fwd: 0 }); s.run(3);
  const hp = s.host.world.players[2];
  const err = Math.hypot(c.me.x - hp.x, c.me.y - hp.y, c.me.z - hp.z), errView = Math.hypot(c.localView().x - hp.x, c.localView().y - hp.y);
  console.log(`  [prediction] settled error=${err.toFixed(5)} view error=${errView.toFixed(5)}`);
  assert.ok(err < 1 && errView < 1);
  assert.ok(c.pending.length < 40, 'pending acked: ' + c.pending.length);
});

test('reconciliation converges after a server-side shove (knockback/teleport) under latency+loss', () => {
  const s = session({ latency: 150, jitter: 20, loss: 0.05, seed: 11, sources: { 2: () => ({ fwd: 0 }) } });
  s.run(3);
  const hp = s.host.world.players[2]; hp.x += 120; hp.vx = 300; // authoritative push
  const c = s.clients[2];
  s.run(2.5);
  const err = Math.hypot(c.me.x - hp.x, c.me.y - hp.y);
  assert.ok(err < 1, 'err ' + err); assert.ok(c.stats.maxCorrection > 50, 'correction was observed');
});

test('delta snapshots are small and loss-tolerant (falls back to full when baseline missing)', () => {
  const s = session({ latency: 60, loss: 0.2, seed: 5, sources: { 2: wander(1), 3: wander(2) } });
  s.run(10);
  const h = s.host.stats;
  console.log(`  [snapshots] sent=${h.snapshots} full=${h.full} last=${h.lastSnapBytes}B avg=${(h.bytesOut / h.snapshots).toFixed(0)}B/snapshot`);
  assert.ok(h.full < h.snapshots * 0.5);
  assert.ok(h.lastSnapBytes < 200);
  assert.equal(s.clients[2].stats.missingBase, 0);
  // client state matches host state for the remote player (at snapshot time)
  const c = s.clients[2]; s.net.set({ loss: 0 }); s.run(1);
  const known = c.snapStates.get(c.lastSnapTick)[3], truth = s.host.world.players[3];
  assert.ok(Math.hypot(known.x - truth.x, known.y - truth.y) < 400 * 0.2);
});

test('remote interpolation is smooth (no snaps/freezes) with jitter and loss, and accurate vs truth', () => {
  let t = 0;
  const circle = () => { t++; return { fwd: 0.6, yaw: t * 0.02 }; }; // 252 u/s on a ~210 unit radius circle
  const s = session({ latency: 80, jitter: 25, loss: 0.05, seed: 9, sources: { 2: () => ({}), 3: circle } });
  s.run(1); s.host.world.players[3].x = 512; s.host.world.players[3].y = 400;
  s.run(3); // warm up
  const pts = [], errs = [];
  s.hooks.push(() => {
    const r = s.clients[2].remotePlayers()[3]; if (!r) return;
    pts.push({ x: r.x, y: r.y });
    const truth = s.host.posAt(Math.round(s.clients[2].renderTick)); if (truth && truth[3]) errs.push(Math.hypot(truth[3].x - r.x, truth[3].y - r.y));
  });
  s.run(12);
  const d = []; for (let i = 1; i < pts.length; i++) d.push(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const sorted = d.slice().sort((a, b) => a - b), med = sorted[d.length >> 1];
  const maxDev = Math.max(...d.map(x => Math.abs(x - med))), stalls = d.filter(x => x < 0.5 * med).length;
  const meanErr = errs.reduce((a, b) => a + b, 0) / errs.length;
  console.log(`  [interp] median step=${med.toFixed(2)}u maxDeviation=${maxDev.toFixed(2)}u stalls=${stalls} meanErrVsTruth=${meanErr.toFixed(2)}u frames=${d.length}`);
  assert.ok(med > 3.5 && med < 5);
  assert.ok(maxDev < 0.35 * med, 'max frame-step deviation ' + maxDev);
  assert.equal(stalls, 0);
  assert.ok(meanErr < 3);
});

function lagCompTrial(maxRewindMs, rttOneWay) {
  // target runs back and forth across the shooter's front; shooter "aims at what it sees" and fires.
  const targetSrc = c => { const y = c.me ? c.me.y : 500; c.dir = c.dir || 1; if (y > 850) c.dir = -1; if (y < 150) c.dir = 1; return { fwd: 1, yaw: c.dir * Math.PI / 2 }; };
  let sh = null;
  const shooterSrc = c => {
    const r = c.remotePlayers()[3]; const me = c.me;
    if (!r || !me) return {};
    const dx = r.x - me.x, dy = r.y - me.y, dz = (r.z + 28) - (me.z + S.EYE);
    const yaw = Math.atan2(dy, dx), pitch = Math.atan2(dz, Math.hypot(dx, dy));
    return { yaw, pitch, buttons: c.localTick % 40 === 0 ? S.BTN.FIRE : 0 };
  };
  const s = session({ latency: rttOneWay, jitter: 4, loss: 0, seed: 21, maxRewindMs, sources: { 2: shooterSrc, 3: targetSrc } });
  s.run(1);
  const sp = s.host.world.players[2]; sp.x = 100; sp.y = 500; sp.ammo[0] = 5000; sp.spawnProt = 0;
  // players own their position by commands; teleport shooter authoritatively and let client reconcile
  s.run(1);
  let fired = 0, hits = 0;
  s.hooks.push(() => { const p3 = s.host.world.players[3]; p3.health = 100; p3.spawnProt = 0; p3.alive = true;
    for (const e of s.host.world.events) { if (e.t === 'fire' && e.p === 2) fired++; if (e.t === 'hit' && e.p === 2) hits++; } });
  s.run(30);
  return { fired, hits };
}
test('lag compensation: target at 420 u/s is hit at 120 ms RTT (60 ms one-way), rewind cap 200 ms; fails without it', () => {
  const on = lagCompTrial(200, 60), off = lagCompTrial(0, 60);
  console.log(`  [lagcomp] with: ${on.hits}/${on.fired}   without: ${off.hits}/${off.fired}`);
  assert.ok(on.fired >= 25);
  assert.ok(on.hits / on.fired >= 0.85, 'lag comp hit rate');
  assert.ok(off.hits / off.fired <= 0.35, 'without lag comp hits miss moving target');
});
test('lag compensation rewind is capped at 200 ms (240 ms one-way client misses more than 60 ms one-way)', () => {
  const near = lagCompTrial(200, 60), far = lagCompTrial(200, 240);
  console.log(`  [lagcomp cap] 60ms one-way: ${near.hits}/${near.fired}   240ms one-way: ${far.hits}/${far.fired}`);
  assert.ok(near.hits / near.fired > far.hits / far.fired);
});

test('inputs survive drops: 30% loss with 3-fold redundancy still executes nearly every command', () => {
  const s = session({ latency: 50, loss: 0.3, seed: 2, sources: { 2: wander(3) } });
  s.run(15);
  const peer = s.host.peers.get(2), c = s.clients[2];
  const executed = peer.lastExec, sent = c.seq - 12;
  console.log(`  [redundancy] sent=${sent} executed=${executed} skipped=${s.host.stats.skippedCommands}`);
  assert.ok(s.host.stats.skippedCommands / sent < 0.06);
  // gaps DID cause divergence (corrections happened); after settling, prediction converges anyway
  console.log(`  [redundancy] corrections=${c.stats.corrections} maxCorrection=${c.stats.maxCorrection.toFixed(1)}u`);
  s.net.set({ loss: 0.3 }); c.inputSource = () => ({}); s.run(4);
  const hp = s.host.world.players[2];
  assert.ok(Math.hypot(c.me.x - hp.x, c.me.y - hp.y) < 1, 'converged under 30% loss');
});

test('host gameplay through the network: client fires, host applies damage, events reach the other client', () => {
  let tt = 0;
  const s = session({ latency: 30, sources: { 2: c => ({ yaw: 0, buttons: (tt++ % 30 === 0) ? 1 : 0 }), 3: () => ({ yaw: 0 }) } });
  s.run(1);
  const a = s.host.world.players[2], b = s.host.world.players[3];
  a.x = 100; a.y = 500; b.x = 300; b.y = 500; a.spawnProt = b.spawnProt = 0; s.run(0.5);
  a.x = 100; a.y = 500; b.x = 300; b.y = 500; s.run(0.2);
  const evs = []; s.hooks.push(() => evs.push(...s.clients[3].drainEvents()));
  s.run(4);
  assert.ok(b.health < 100 || b.deaths > 0 || a.frags > 0, 'target took damage on host');
  assert.ok(evs.some(e => e.t === 'fire') && evs.some(e => e.t === 'hit' || e.t === 'kill'), 'events delivered');
  assert.equal(s.clients[3].auth.health, s.clients[3].me.health);
});
