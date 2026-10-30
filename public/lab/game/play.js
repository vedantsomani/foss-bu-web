// play.js - netcode test page: host + local client + bots wired through an in-memory link with adjustable latency/jitter/loss.
import { MemoryNetwork } from '../net/transport.js';
import { GameHost } from '../net/host.js';
import { GameClient } from '../net/client.js';
import * as S from '../game/sim.js';
import { WEAPONS } from '../game/weapons.js';
import * as VM from '../game/viewmodel.js';
import { loadWeaponSprites } from '../game/sprites.js';
import { fetchGz, readLumps, parseMapLite } from '../game/wadlite.js';

const $ = id => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const mapCanvas = $('map'), vmCanvas = $('vm'), g = mapCanvas.getContext('2d'), vg = vmCanvas.getContext('2d');
const dpr = Math.min(2, window.devicePixelRatio || 1);
function resize() {
  for (const c of [mapCanvas, vmCanvas]) { c.width = Math.round(innerWidth * dpr); c.height = Math.round(innerHeight * dpr); }
}
addEventListener('resize', resize); resize();

// ---------------------------------------------------------------- load WAD (map from shared wad.js if present, else wadlite)
let map, sprites = null, mapSource = 'wadlite', bsp = null;
try {
  const ab = await fetchGz('../../freedm.wad.gz');
  try {
    const wad = await import('../wad.js');
    map = wad.parseMap(wad.readWad(ab), qs.get('map') || 'MAP01');
    bsp = (x, y) => wad.pointInSector(map, x, y); mapSource = 'wad.js';
  } catch (e) { map = parseMapLite(readLumps(ab), qs.get('map') || 'MAP01'); }
  try { sprites = loadWeaponSprites(ab, (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }); } catch (e) { console.warn('sprites', e); }
} catch (e) {
  console.warn('WAD unavailable, using fixture room', e);
  const { arena } = await import('../tests/fixtures.js'); map = arena(); mapSource = 'fixture';
}

// ---------------------------------------------------------------- network + players
const net = new MemoryNetwork({ latency: 75, jitter: 10, loss: 0.05, seed: 1234 });
const simOpts = bsp ? { pointInSector: bsp } : {};
const host = new GameHost({ map, endpoint: net.endpoint(1), seed: 2025, simOpts });
const keys = new Set(); let mouse = { x: innerWidth / 2, y: innerHeight / 2 }, firing = false, wantWeapon = 0, zoom = 0.28;
let jumpQueued = false;

const autotest = qs.has('autotest');
let atTick = 0;
function localInput() {
  const me = client.me; if (!me) return {};
  if (autotest) { atTick++; return { fwd: 1, side: (atTick >> 6) & 1 ? 1 : 0, yaw: (atTick * 0.02) % 6.283, buttons: S.BTN.SPRINT | (atTick % 90 === 0 ? S.BTN.JUMP : 0) | (atTick % 25 < 2 ? S.BTN.FIRE : 0) }; }
  const sw = 0, cx = innerWidth / 2, cy = innerHeight / 2;
  const yaw = Math.atan2(-(mouse.y - cy), mouse.x - cx);
  const fwd = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0), side = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  let buttons = 0; if (firing) buttons |= S.BTN.FIRE; if (keys.has('ShiftLeft') || keys.has('ShiftRight')) buttons |= S.BTN.SPRINT;
  if (keys.has('Space') || jumpQueued) { buttons |= S.BTN.JUMP; jumpQueued = false; }
  const weapon = wantWeapon; wantWeapon = 0;
  return { fwd, side, yaw, pitch: 0, buttons, weapon };
}
const client = new GameClient({ map, endpoint: net.endpoint(2), id: 2, inputSource: localInput });
// two bots, each a real GameClient on its own link
function botSource(seedN) {
  let st = seedN, tick = 0, heading = 0, last = null, stuck = 0, tgt = null;
  const r = () => ((st = (Math.imul(st, 1664525) + 1013904223) >>> 0) / 4294967296);
  return c => {
    const me = c.me; if (!me) return {};
    tick++;
    if (tick % 90 === 0 || stuck > 10) { heading = r() * 6.283; stuck = 0; }
    if (last && Math.hypot(me.x - last.x, me.y - last.y) < 1.5) stuck++; else stuck = 0; last = { x: me.x, y: me.y };
    let best = null, bd = 700;
    const rem = c.remotePlayers(); rem[2] = rem[2];
    for (const k in rem) { const o = rem[k]; if (!o.alive) continue; const d = Math.hypot(o.x - me.x, o.y - me.y); if (d < bd) { bd = d; best = o; } }
    if (best) { const yaw = Math.atan2(best.y - me.y, best.x - me.x); heading = yaw; return { fwd: bd > 200 ? 1 : 0, side: Math.sin(tick / 20), yaw, pitch: 0, buttons: (tick % 12 < 2 ? S.BTN.FIRE : 0), weapon: tick % 300 === 0 ? 1 + Math.floor(r() * 4) : 0 }; }
    return { fwd: 1, yaw: heading, buttons: S.BTN.SPRINT };
  };
}
const bots = [3, 4].map(id => { const c = new GameClient({ map, endpoint: net.endpoint(id), id, inputSource: null }); c.inputSource = () => botSource(id * 7919)(c); const src = botSource(id * 7919); c.inputSource = () => src(c); return c; });

// ---------------------------------------------------------------- input
addEventListener('keydown', e => { if (e.target.tagName === 'INPUT') return; keys.add(e.code); if (e.code === 'Space') { jumpQueued = true; e.preventDefault(); } const n = +e.key; if (n >= 1 && n <= 7) wantWeapon = n; });
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); firing = false; });
mapCanvas.addEventListener('mousemove', e => { mouse = { x: e.clientX, y: e.clientY }; });
addEventListener('mousemove', e => { mouse = { x: e.clientX, y: e.clientY }; });
addEventListener('mousedown', e => { if (e.target.tagName !== 'INPUT') firing = true; });
addEventListener('mouseup', () => { firing = false; });
addEventListener('wheel', e => { zoom = Math.max(0.08, Math.min(1.2, zoom * (e.deltaY < 0 ? 1.1 : 0.9))); }, { passive: true });
addEventListener('contextmenu', e => e.preventDefault());
for (const id of ['lat', 'jit', 'loss']) $(id).addEventListener('input', applyNet);
function applyNet() {
  const lat = +$('lat').value, jit = +$('jit').value, loss = +$('loss').value;
  $('latO').textContent = lat + ' ms'; $('jitO').textContent = jit + ' ms'; $('lossO').textContent = loss + ' %';
  net.set({ latency: lat, jitter: jit, loss: loss / 100 });
}
applyNet();

// ---------------------------------------------------------------- drawing
const COLORS = { 1: '#ffffff', 2: '#4cc2ff', 3: '#ff6b6b', 4: '#7be07b' };
const fx = []; const feed = [];
const vm = VM.createViewModel(); let lastYaw = null, vmActive = true;
function w2s(x, y, cam) { return [(x - cam.x) * zoom * dpr + mapCanvas.width / 2, (cam.y - y) * zoom * dpr + mapCanvas.height / 2]; }
function drawMap(cam) {
  g.fillStyle = '#0d0f12'; g.fillRect(0, 0, mapCanvas.width, mapCanvas.height);
  g.lineWidth = Math.max(1, dpr);
  const P = S.prepareMap(map);
  for (const l of P.lines) {
    const [ax, ay] = w2s(l.ax, l.ay, cam), [bx, by] = w2s(l.bx, l.by, cam);
    if (l.oneSided) g.strokeStyle = '#c9ced6';
    else { const f = map.sectors[l.fs], b = map.sectors[l.bs]; const dh = Math.abs(f.floor - b.floor); g.strokeStyle = l.impassable ? '#c05050' : dh > 24 ? '#c08a30' : dh > 0 ? '#5a7a4a' : '#2b3340'; }
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
  }
  const w = host.world;
  w.pickups.forEach((pk, i) => {
    const [x, y] = w2s(pk.x, pk.y, cam), t = pk.type; const active = client.pickupActive(i);
    g.fillStyle = !active ? '#333' : t >= 2001 && t <= 2006 || t === 82 ? '#ff5050' : t === 2011 || t === 2012 || t === 2014 || t === 2013 ? '#50e070' : t === 2015 || t === 2018 || t === 2019 || t === 83 ? '#5090ff' : '#e0d050';
    const s = 5 * dpr; g.fillRect(x - s / 2, y - s / 2, s, s);
  });
}
function disc(x, y, z, color, fill, label, yaw) {
  const [sx, sy] = w2s(x, y, cam); const r = S.RADIUS * zoom * dpr;
  g.beginPath(); g.arc(sx, sy, r, 0, 7); if (fill) { g.fillStyle = color; g.globalAlpha = 0.85; g.fill(); g.globalAlpha = 1; } g.strokeStyle = color; g.stroke();
  if (yaw !== undefined) { g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + Math.cos(yaw) * r * 1.8, sy - Math.sin(yaw) * r * 1.8); g.stroke(); }
  if (label) { g.fillStyle = '#d8dee6'; g.font = `${11 * dpr}px ui-monospace,monospace`; g.fillText(label, sx + r + 3, sy - r); }
}
let cam = { x: 0, y: 0 };
function frame(now) {
  net.update(now); host.update(now); client.update(now); for (const b of bots) b.update(now);
  const me = client.localView();
  if (me) { cam.x += (me.x - cam.x) * 0.2; cam.y += (me.y - cam.y) * 0.2; }
  drawMap(cam);
  // events -> fx / feed
  for (const e of client.drainEvents()) {
    if (e.t === 'explode') fx.push({ x: e.x, y: e.y, r: 20, ttl: 18, c: '#ff9d2e' });
    else if (e.t === 'impact') fx.push({ x: e.x, y: e.y, r: 4, ttl: 8, c: '#ffe08a' });
    else if (e.t === 'kill') { feed.push({ t: now, s: `P${e.killer} fragged P${e.victim} (${WEAPONS[e.w]?.name || '?'})` }); if (feed.length > 5) feed.shift(); }
  }
  const lev = client.drainLocalEvents();
  if (me) {
    const dyaw = lastYaw === null ? 0 : ((me.yaw - lastYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI; lastYaw = me.yaw;
    const view = { x: me.x, y: me.y, z: me.z, yaw: me.yaw, pitch: me.pitch, eyeZ: me.eyeZ };
    const pose = VM.updateViewModel(vm, 1 / 60 * 1, { speed: Math.hypot(me.vx, me.vy), grounded: me.grounded, sprint: false, lookDX: dyaw, weapon: me.weapon, wstate: me.wstate, wtimer: me.wtimer, events: lev, player: view, stepOff: me.stepOff });
    for (const ev of VM.drainViewEvents(vm)) if (ev.type === 'muzzle') fx.push({ x: ev.x, y: ev.y, r: 40, ttl: 5, c: '#fff2a0', light: true });
    vg.clearRect(0, 0, vmCanvas.width, vmCanvas.height);
    if (me.alive) VM.drawViewModel(vg, pose, sprites, vmCanvas.width, vmCanvas.height, { baseline: -10 });
  }
  for (const f of fx) { const [x, y] = w2s(f.x, f.y, cam); g.beginPath(); g.arc(x, y, f.r * zoom * dpr * (f.light ? 1 : 1 + (18 - f.ttl) * 0.08), 0, 7); g.globalAlpha = Math.max(0, f.ttl / 18); g.fillStyle = f.c; g.fill(); g.globalAlpha = 1; f.ttl--; }
  for (let i = fx.length - 1; i >= 0; i--) if (fx[i].ttl <= 0) fx.splice(i, 1);
  // projectiles as the client knows them
  for (const p of client.projectiles) { const [x, y] = w2s(p.x, p.y, cam); g.fillStyle = '#ff9d2e'; g.beginPath(); g.arc(x, y, 3 * dpr, 0, 7); g.fill(); }
  const showAuth = $('showAuth').checked, showBots = $('showBots').checked;
  // authoritative (host) positions
  if (showAuth) for (const id in host.world.players) { const p = host.world.players[id]; if (!p.alive) continue; disc(p.x, p.y, p.z, 'rgba(255,255,255,.7)', false); }
  // remote, interpolated
  if (showBots) { const rem = client.remotePlayers(); for (const id in rem) { const p = rem[id]; if (!p.alive) continue; disc(p.x, p.y, p.z, COLORS[id] || '#bbb', true, `P${id} ${p.health}hp`, p.yaw); } }
  if (me && me.alive) {
    if (showAuth && client.auth) { const [ax, ay] = w2s(client.auth.x, client.auth.y, cam), [mx, my] = w2s(me.x, me.y, cam); g.strokeStyle = '#ff4d4d'; g.beginPath(); g.moveTo(ax, ay); g.lineTo(mx, my); g.stroke(); disc(client.auth.x, client.auth.y, 0, '#ff4d4d', false); }
    disc(me.x, me.y, me.z, COLORS[2], true, `YOU ${me.health}hp ${me.armor}ar`, me.yaw);
  }
  hud(me, now);
  requestAnimationFrame(frame);
}
let lastBytes = 0, lastBytesT = 0, kbps = 0;
function hud(me, now) {
  const hs = host.stats, cs = client.stats;
  if (now - lastBytesT > 1000) { kbps = (hs.bytesOut - lastBytes) * 8 / 1000 / ((now - lastBytesT) / 1000 || 1); lastBytes = hs.bytesOut; lastBytesT = now; }
  if (me) {
    const w = WEAPONS[me.weapon];
    g.fillStyle = '#d8dee6'; g.font = `${15 * dpr}px ui-monospace,monospace`; g.textAlign = 'center';
    g.fillText(`${me.alive ? '' : 'DEAD '}HP ${me.health}  AR ${me.armor}  ${w.name}  ${me.ammo.join('/')}  frags ${me.frags}${me.spawnProt > 0 ? '  [protected]' : ''}`, mapCanvas.width / 2, mapCanvas.height - 12 * dpr); g.textAlign = 'left';
  }
  g.font = `${12 * dpr}px ui-monospace,monospace`; g.fillStyle = '#9fb0c3';
  feed.forEach((f, i) => g.fillText(f.s, 12 * dpr, mapCanvas.height - (100 + i * 16) * dpr));
  $('stats').textContent =
`map ${mapSource}  host tick ${host.world.tick}
RTT ${cs.rtt.toFixed(0)} ms   pending ${client.pending.length}
corrections ${cs.corrections}  last ${cs.lastCorrection.toFixed(2)}u  max ${cs.maxCorrection.toFixed(1)}u
snapshot ${hs.lastSnapBytes || 0} B  full ${hs.full}/${hs.snapshots}   host out ${kbps.toFixed(1)} kbit/s
render delay ${(client.lastSnapTick - client.renderTick).toFixed(1)} ticks  skipped cmds ${hs.skippedCommands}
lag-comp shots ${hs.lagCompUsed}  net drops ${net.stats.dropped}/${net.stats.sent}`;
}
window.__fragline = { net, host, client, bots, vm, S, VM, get map() { return map; }, mapSource, get sprites() { return sprites; } };
document.title = 'Fragline netcode lab';
requestAnimationFrame(frame);
window.__ready = true;
