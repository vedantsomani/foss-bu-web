// Exploding barrels (thing 2035): shootable, solid, chain reactions, kill credit, and in sync over the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../game/sim.js';
import { buildMap } from './fixtures.js';
import { MemoryNetwork } from '../net/transport.js';
import { GameHost } from '../net/host.js';
import { GameClient } from '../net/client.js';

const dm = (x, y, angle = 0) => ({ x, y, angle, type: 11, flags: 7 });
const barrel = (x, y) => ({ x, y, angle: 0, type: S.BARREL, flags: 7 });
// barrels at x=400 and x=440 (in blast range of each other), one far away at x=900
const barrelMap = () => buildMap([{ x0: 0, y0: 0, x1: 1024, y1: 1024 }],
  [dm(100, 512), dm(420, 600, 270), barrel(400, 512), barrel(440, 512), barrel(900, 900)]);

function setup() {
  const world = S.createWorld(barrelMap(), 7);
  S.addPlayer(world, 1); S.addPlayer(world, 2);
  const p = world.players[1], q = world.players[2];
  Object.assign(p, { x: 100, y: 512, spawnProt: 0 });
  Object.assign(q, { x: 420, y: 560, spawnProt: 0 });
  return { world, p, q };
}
// fire the pistol straight along +x until the given tick count; returns all events
function run(world, ticks, fire = () => true) {
  const events = [];
  for (let t = 0; t < ticks; t++) {
    // tap fire with autoaim on, as the play client sends it; a level shot alone would pass over a 42-unit barrel
    const inp = S.quantizeInput(S.makeInput({ yaw: 0, pitch: 0, buttons: fire(t) && (t & 8) ? S.BTN.FIRE | S.BTN.AUTOAIM : S.BTN.AUTOAIM, seq: world.tick + 1, viewTick: world.tick }));
    S.step(world, { 1: inp });
    events.push(...world.events);
  }
  return events;
}

test('barrels: bullets set a barrel off, it explodes after its fuse, sets off its neighbour, and hurts nearby players', () => {
  const { world, q } = setup();
  const ev = run(world, 600);
  const lit = ev.filter(e => e.t === 'barrel').map(e => e.idx);
  assert.deepEqual(lit.slice(0, 2), [0, 1], 'shot barrel lights first, then the chained neighbour');
  const booms = ev.filter(e => e.t === 'explode' && e.w === S.BARREL_EVW);
  assert.equal(booms.length, 2, 'both nearby barrels explode');
  assert.equal(world.barrels[2].st, 0, 'the far barrel is untouched');
  assert.ok(ev.some(e => e.t === 'hit' && e.target === 2 && e.splash), 'a player near the blast is damaged');
  assert.ok(q.deaths > 0 || q.health < 100, 'killed (and maybe respawned) or hurt');
});

test('barrels: autoaim pulls a level shot down onto a barrel', () => {
  const { world } = setup();
  const ev = run(world, 40);
  assert.ok(ev.some(e => e.t === 'barrel' && e.idx === 0) || world.barrels[0].hp < S.BARREL_HP, 'the first shots hit the barrel');
});

test('barrels: a barrel kill is credited to the player who set it off', () => {
  const { world, q } = setup();
  q.health = 10;
  const ev = run(world, 600);
  const kill = ev.find(e => e.t === 'kill' && e.victim === 2);
  assert.ok(kill, 'player 2 dies in the blast');
  assert.equal(kill.killer, 1);
});

test('barrels: a rocket hitting a barrel detonates it', () => {
  const { world, p } = setup();
  p.owned = 0x7f; p.ammo = [200, 50, 50, 300];
  const ev = [];
  for (let t = 0; t < 400; t++) {
    const inp = S.quantizeInput(S.makeInput({ yaw: 0, pitch: 0, buttons: t > 60 && t < 64 ? S.BTN.FIRE : 0, weapon: t < 3 ? 5 : 0, seq: world.tick + 1, viewTick: world.tick }));
    S.step(world, { 1: inp });
    ev.push(...world.events);
  }
  assert.ok(ev.some(e => e.t === 'barrel' && e.idx === 0));
  assert.equal(world.barrels[0].st, 2);
});

test('barrels: standing barrels are solid, exploded ones are not', () => {
  const { world, p } = setup();
  Object.assign(p, { x: 340, y: 512 });
  for (let t = 0; t < 120; t++) S.step(world, { 1: S.quantizeInput(S.makeInput({ fwd: 1, yaw: 0, seq: world.tick + 1 })) });
  assert.ok(400 - p.x >= S.RADIUS + S.BARREL_R - 0.01, `walked into the barrel: x=${p.x}`);
  world.barrels[0].st = 2; world.barrels[1].st = 2;
  for (let t = 0; t < 60; t++) S.step(world, { 1: S.quantizeInput(S.makeInput({ fwd: 1, yaw: 0, seq: world.tick + 1 })) });
  assert.ok(p.x > 420, 'walks through where the barrels were');
});

test('barrels: state survives serialize/deserialize', () => {
  const { world } = setup();
  run(world, 30);
  world.barrels[1].st = 1; world.barrels[1].fuse = 5; world.barrels[1].src = 1;
  const copy = S.deserialize(S.serialize(world), world.map);
  assert.deepEqual(copy.barrels.map(b => [b.st, b.hp, b.fuse, b.src]), world.barrels.map(b => [b.st, b.hp, b.fuse, b.src]));
  assert.equal(S.hashWorld(copy), S.hashWorld(world));
});

test('barrels: clients learn which barrels are gone (and stop colliding with them)', () => {
  const net = new MemoryNetwork({ latency: 40, jitter: 10, loss: 0.05, seed: 3 });
  const map = barrelMap();
  const host = new GameHost({ map, endpoint: net.endpoint(1), seed: 5, localId: 1 });
  const client = new GameClient({ map, endpoint: net.endpoint(2), id: 2, inputSource: () => ({ fwd: 0, side: 0, yaw: 0, pitch: 0, buttons: 0, weapon: 0 }) });
  let now = 0;
  for (let i = 0; i < 120; i++) { now += 1000 / 60; host.localInput({ fwd: 0, side: 0, yaw: 0, pitch: 0, buttons: 0, weapon: 0 }); host.update(now); client.update(now); net.update(now); }
  assert.ok(client.barrelStanding(0) && client.barrelStanding(1));
  host.world.barrels[0].st = 2; host.world.barrels[1].st = 2;
  for (let i = 0; i < 120; i++) { now += 1000 / 60; host.localInput({ fwd: 0, side: 0, yaw: 0, pitch: 0, buttons: 0, weapon: 0 }); host.update(now); client.update(now); net.update(now); }
  assert.equal(client.barrelStanding(0), false);
  assert.equal(client.barrelStanding(1), false);
  assert.equal(client.barrelStanding(2), true);
  assert.equal(client.pw.barrels[0].st, 2, 'prediction world no longer treats it as solid');
});
