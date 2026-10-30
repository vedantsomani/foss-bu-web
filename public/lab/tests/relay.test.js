// Integration: real lan_server.py relay + RelayTransport over real WebSockets, real wall-clock time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { RelayTransport } from '../net/transport.js';
import { GameHost } from '../net/host.js';
import { GameClient } from '../net/client.js';
import * as S from '../game/sim.js';
import { arena } from './fixtures.js';

const PORT = 8812, BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('host + client play through the real relay (room API, uid 1 announce, binary framing)', async t => {
  const srv = spawn('python3', ['/home/user/foss-bu-web/lan_server.py', '--port', String(PORT)], { stdio: 'ignore' });
  t.after(() => { try { srv.kill('SIGTERM'); } catch {} });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { await sleep(100); try { up = (await fetch(BASE + '/api/newroom?players=2', { headers: { 'X-Fragline': '1' } })).ok; } catch {} }
  if (!up) return t.skip('lan_server.py not startable (python websockets missing?)');
  const { room } = await (await fetch(BASE + '/api/newroom?players=2', { headers: { 'X-Fragline': '1' } })).json();
  assert.match(room, /^[a-z0-9]{8}$/);
  const map = arena();
  const hostT = new RelayTransport(`ws://127.0.0.1:${PORT}/api/ws/${room}`, 1);
  const cliT = new RelayTransport(`ws://127.0.0.1:${PORT}/api/ws/${room}`, 2);
  await Promise.all([hostT, cliT].map(x => new Promise((res, rej) => { x.onOpen = res; setTimeout(() => rej(new Error('ws open timeout')), 3000); })));
  const host = new GameHost({ map, endpoint: hostT, seed: 5 });
  let n = 0;
  const client = new GameClient({ map, endpoint: cliT, id: 2, inputSource: () => ({ fwd: 1, yaw: (n++ / 60) * 1.2, buttons: S.BTN.SPRINT }) });
  const timer = setInterval(() => { const now = performance.now(); host.update(now); client.update(now); }, 4);
  t.after(() => { clearInterval(timer); hostT.close(); cliT.close(); });
  await sleep(3000);
  client.inputSource = () => ({}); await sleep(1200);
  clearInterval(timer);
  const hp = host.world.players[2];
  console.log(`  [relay] room=${room} host tick=${host.world.tick} snapshots=${client.stats.snapshots} rtt=${client.stats.rtt.toFixed(1)}ms corrections=${client.stats.corrections} bytesIn=${client.stats.bytesIn}`);
  assert.ok(client.ready && client.stats.snapshots > 80);
  assert.ok(host.world.tick > 200);
  assert.ok(Math.hypot(client.me.x - hp.x, client.me.y - hp.y) < 1, 'predicted == authoritative over real relay');
});
