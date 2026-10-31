// main.js - Fragline game client: menus, lobby, render loop, event -> audio/FX/HUD glue.
import { fetchWad, parseMap } from '../wad.js';
import { createRenderer } from '../render/renderer.js';
import * as S from '../game/sim.js';
import { WEAPONS, ITEMS } from '../game/weapons.js';
import * as VM from '../game/viewmodel.js';
import { loadWeaponSprites } from '../game/sprites.js';
import { Input } from './input.js';
import { GameAudio } from './audio.js';
import { Hud } from './hud.js';
import { HostSession, ClientSession } from './session.js';
import { newRoom, roomStatus, HostLobby, ClientLobby, roomLink } from './lobby.js';
import { loadSettings, saveSettings, QUALITY } from './settings.js';
import { DynRes } from './perf.js';
import { BOT_NAMES } from './bots.js';
import { PICKUP_SPRITES, FX, FIRE_SOUND, PROJ } from './things.js';

const $ = id => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const TAU = Math.PI * 2;
const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; };
const settings = loadSettings();
const audio = new GameAudio();
const hud = new Hud();
let glCanvas = $('gl');
const vmCanvas = $('vm'), vg = vmCanvas.getContext('2d', { alpha: true });
const input = new Input(glCanvas, settings);
input.forceActive = qs.has('nolock');
let G = null, lobby = null, wadP = null;

// ---------------------------------------------------------------- screens
const screens = ['menu', 'lobby', 'loading', 'click', 'pause', 'over', 'settings'];
function show(...names) { for (const s of screens) if (s !== 'settings') $(s).hidden = !names.includes(s); }
for (const sel of document.querySelectorAll('.mapsel')) for (let i = 1; i <= 32; i++) sel.add(new Option('MAP' + String(i).padStart(2, '0'), 'MAP' + String(i).padStart(2, '0')));
const err = (id, m) => { $(id).textContent = m || ''; };

// ---------------------------------------------------------------- settings UI
const sUI = [['sSens', 'oSens', 'sens', v => (+v).toFixed(2)], ['sPad', 'oPad', 'padSens', v => (+v).toFixed(2)], ['sFov', 'oFov', 'fov', v => v + '°'], ['sVol', 'oVol', 'volume', v => Math.round(v * 100) + '%']];
function syncSettingsUI() {
  for (const [i, o, k, f] of sUI) { $(i).value = settings[k]; $(o).textContent = f(settings[k]); }
  $('sInvert').checked = settings.invertY; $('sQuality').value = settings.quality; $('sFps').value = String(settings.fpsCap); $('sDyn').checked = settings.dynRes; $('sShowFps').checked = settings.showFps;
}
function applySettings() {
  audio.setVolume(settings.volume);
  if (G) { applyQuality(); G.dyn.enabled = settings.dynRes; if (!settings.dynRes) { G.dyn.reset(); applyQuality(); } }
  hud.fps(settings.showFps ? hud.c.fps || '' : ''); saveSettings(settings);
}
for (const [i, o, k, f] of sUI) $(i).addEventListener('input', () => { settings[k] = +$(i).value; $(o).textContent = f(settings[k]); applySettings(); });
$('sInvert').onchange = () => { settings.invertY = $('sInvert').checked; applySettings(); };
$('sQuality').onchange = () => { settings.quality = $('sQuality').value; applySettings(); };
$('sFps').onchange = () => { settings.fpsCap = +$('sFps').value; applySettings(); };
$('sDyn').onchange = () => { settings.dynRes = $('sDyn').checked; applySettings(); };
$('sShowFps').onchange = () => { settings.showFps = $('sShowFps').checked; applySettings(); };
const openSettings = () => { syncSettingsUI(); $('settings').hidden = false; };
$('bSettings').onclick = openSettings; $('bPauseSettings').onclick = openSettings; $('bSettingsClose').onclick = () => { $('settings').hidden = true; };
syncSettingsUI(); audio.setVolume(settings.volume);

// ---------------------------------------------------------------- assets
function getWad() {
  return wadP || (wadP = fetchWad('../../freedm.wad.gz').then(wad => {
    const sprites = loadWeaponSprites(wad.buffer, (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; });
    return { wad, sprites };
  }));
}

// ---------------------------------------------------------------- starting matches
async function gesture() { audio.unlock(); if (!input.forceActive) input.lock(true); }
function loading(msg) { $('loadMsg').textContent = msg; show('loading'); }
const hostName = id => (id === 1 ? 'Host' : 'Player ' + id);

$('bPractice').onclick = async () => {
  gesture(); loading('Loading map...'); err('menuErr');
  try {
    const { wad, sprites } = await getWad(); audio.load(wad);
    const mapName = $('pMap').value, map = parseMap(wad, mapName);
    loading('Building level and bots...'); await new Promise(r => setTimeout(r, 30));
    const session = new HostSession({ map, bots: +$('pBots').value, skill: +$('pSkill').value });
    session.names = { ...session.names, 1: 'You' };
    beginMatch({ session, map, wad, sprites, mapName, timeLimit: 10 });
  } catch (e) { console.error(e); show('menu'); err('menuErr', 'Could not start: ' + (e.message || e)); }
};

$('bHost').onclick = async () => {
  audio.unlock(); err('menuErr');
  try {
    const max = +$('hMax').value, code = await newRoom(max);
    const cfg = { map: $('hMap').value, max, time: +$('hTime').value, fill: $('hBots').checked };
    getWad().catch(() => {});
    lobby = new HostLobby(code, cfg); lobby.isHost = true;
    lobby.onChange = ids => {
      renderLobby(ids, cfg, code);
      if (ids.length >= cfg.max && !autoStart) { err('lobbyErr', 'Everyone is here - starting...'); autoStart = setTimeout(() => $('bStart').onclick(), 2000); }   // all slots filled
      else if (ids.length < cfg.max && autoStart) { clearTimeout(autoStart); autoStart = 0; err('lobbyErr'); }
    };
    lobby.onError = m => { err('lobbyErr', m); };
    renderLobby([1], cfg, code); show('lobby');
  } catch (e) { err('menuErr', e.message); }
};
let autoStart = 0;
$('bStart').onclick = async () => {
  if (!lobby || !lobby.isHost) return;
  clearTimeout(autoStart); autoStart = 0; gesture(); const cfg = lobby.cfg; const lb = lobby;
  loading('Starting match...');
  try {
    const humans = await lb.start({ time: cfg.time });
    const { wad, sprites } = await getWad(); audio.load(wad);
    const map = parseMap(wad, cfg.map);
    const bots = cfg.fill ? cfg.max - 1 - humans.length : 0;
    const session = new HostSession({ map, transport: lb.t, humans, bots });
    session.names = { ...session.names, 1: 'You' }; for (const id of humans) session.names[id] = 'Player ' + id;
    lobby = null; beginMatch({ session, map, wad, sprites, mapName: cfg.map, timeLimit: cfg.time });
  } catch (e) { console.error(e); show('lobby'); err('lobbyErr', 'Could not start: ' + (e.message || e)); }
};

async function joinRoom(code) {
  code = code.trim().toLowerCase(); err('menuErr');
  if (!/^[a-z0-9]{8}$/.test(code)) { err('menuErr', 'Room codes are 8 letters/digits.'); return; }
  audio.unlock();
  try {
    const st = await roomStatus(code);
    if (st.started) throw new Error('That match has already started.');
    if (st.players >= st.maxPlayers) throw new Error('That room is full.');
    getWad().catch(() => {});
    $('lobbyTitle').textContent = 'Joining room'; $('lobbyCode').textContent = code; $('lobbyLinkRow').hidden = true; $('bStart').hidden = true; err('lobbyErr'); show('lobby');
    $('slots').textContent = 'Connecting...';
    lobby = new ClientLobby(code, {
      onUpdate: cfg => renderLobby(cfg.ids, cfg, code, true),
      onError: m => { err('lobbyErr', m); },
      onStart: async (cfg, transport, uid) => {
        loading('Loading map...');
        try {
          const { wad, sprites } = await getWad(); audio.load(wad);
          const map = parseMap(wad, cfg.map);
          const session = new ClientSession({ map, transport, id: uid });
          session.names = { ...Object.fromEntries(cfg.ids.map(id => [id, hostName(id)])), [uid]: 'You' };
          for (let id = 2, k = 0, n = cfg.fill ? cfg.max - cfg.ids.length : 0; k < n && id < 16; id++) if (!cfg.ids.includes(id)) session.names[id] = BOT_NAMES[k++ % BOT_NAMES.length];   // same ids/names the host's bots get
          transport.onClose = () => { if (G) G.closed = true; };
          lobby = null; beginMatch({ session, map, wad, sprites, mapName: cfg.map, timeLimit: cfg.time, needClick: true });
        } catch (e) { console.error(e); show('menu'); err('menuErr', 'Could not load the match: ' + e.message); }
      },
    });
  } catch (e) { show('menu'); err('menuErr', e.message); }
}
$('bJoin').onclick = () => joinRoom($('jCode').value);
$('jCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom($('jCode').value); });
if (qs.get('room')) { $('jCode').value = qs.get('room'); joinRoom(qs.get('room')); }

function renderLobby(ids, cfg, code, joined = false) {
  $('lobbyTitle').textContent = joined ? 'Waiting for the host to start' : 'Your room';
  $('lobbyCode').textContent = code;
  if (!joined) { $('lobbyLink').value = roomLink(code); $('lobbyLinkRow').hidden = false; $('bStart').hidden = false; }
  const box = $('slots'); box.textContent = '';
  for (let i = 0; i < cfg.max; i++) {
    const d = document.createElement('div'), id = ids[i];
    d.className = 'slot ' + (id ? 'on' : 'off'); d.append(document.createElement('i'), id ? (id === 1 ? 'Host' : 'Player ' + id) + (joined && id === lobby?.uid ? ' (you)' : '') : cfg.fill ? 'Open - a bot will fill this slot' : 'Waiting for player...');
    box.appendChild(d);
  }
  $('bStart').textContent = ids.length < cfg.max ? 'Start now (' + ids.length + '/' + cfg.max + ')' : 'Start match';
}
$('bCopy').onclick = async () => { const v = $('lobbyLink').value; try { await navigator.clipboard.writeText(v); } catch { $('lobbyLink').select(); document.execCommand('copy'); } $('bCopy').textContent = 'Copied!'; setTimeout(() => { $('bCopy').textContent = 'Copy link'; }, 1400); };
$('bLobbyLeave').onclick = () => { if (lobby) lobby.close(); lobby = null; if (qs.get('room')) history.replaceState(null, '', location.pathname); show('menu'); $('lobbyLinkRow').hidden = false; $('bStart').hidden = false; };

// ---------------------------------------------------------------- match
const leave = () => { try { if (document.fullscreenElement) document.exitFullscreen(); } catch { /* ignore */ } location.href = location.pathname; };
$('bLeave').onclick = leave; $('bOverLeave').onclick = leave;

function beginMatch({ session, map, wad, sprites, mapName, timeLimit, needClick }) {
  const q = QUALITY[settings.quality];
  const renderMap = { ...map, things: map.things.filter(t => !ITEMS[t.type]) };   // pickups are drawn as entities (they come and go)
  const renderer = createRenderer(glCanvas, wad, renderMap, { renderScale: q.renderScale, bloom: q.bloom, maxLights: q.maxLights, dpr: q.dpr, fov: settings.fov });
  const dyn = new DynRes(scale => applyQuality(scale)); dyn.enabled = settings.dynRes;
  const pk = session.pickups;
  G = {
    session, map, wad, renderer, sprites, mapName, dyn, timeLimit, myId: session.myId, names: session.names,
    vm: VM.createViewModel(), vmCtx: { speed: 0, grounded: true, sprint: false, lookDX: 0, lookDY: 0, weapon: 0, wstate: 0, wtimer: 0, events: [], player: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, eyeZ: 0 }, stepOff: 0 },
    ents: [], pickupEnts: pk.map((p, i) => { const d = PICKUP_SPRITES[p.type]; return { id: 'k' + i, x: p.x, y: p.y, z: p.z, base: p.z, sprite: d[0] + 'A0', fullbright: d[2] ? 1 : 0 }; }),
    pEnt: {}, anim: {}, projEnts: [], projLights: new Map(), fx: Array.from({ length: 48 }, (_, i) => ({ on: false, def: null, t0: 0, ent: { id: 'f' + i, x: 0, y: 0, z: 0, sprite: '', fullbright: 1 } })), fxN: 0,
    lastRender: 0, lastNow: 0, frames: 0, fpsT: 0, fpsN: 0, fps: 0, fpsText: '', yawSet: false, lastYaw: 0, lastPitch: 0, wasAlive: true, killer: '', over: false, closed: false,
    remotes: {}, L: null, jsMs: 0, menuAt: 0, paused: false, started: performance.now(), shown: false, deadAt: 0,
  };
  G.dyn.base = q.renderScale;
  session.sampler = (me, out) => (input.active && !G.over && !G.paused ? input.sample(out, me) : input.neutral(out));
  input.cycle = (dir, me) => {
    const cur = me.wstate !== 0 ? me.pendW : me.weapon;
    for (let k = 1; k <= WEAPONS.length; k++) {
      const w = (cur + dir * k + WEAPONS.length * 8) % WEAPONS.length;
      if ((me.owned >> w) & 1 && me.ammo[WEAPONS[w].ammoType] >= WEAPONS[w].cost) return w + 1;
    }
    return 0;
  };
  input.enabled = true; input.menu = false; input.onEscape = () => { if (performance.now() - G.menuAt < 200) return; if ($('pause').hidden) openPause(); else resume(); };
  input.onUnlock = () => { if (G && !G.over && $('click').hidden) openPause(); };
  input.onScoreboard = v => { G.score = v; };
  vmResize(); addEventListener('resize', vmResize);
  show(); hud.show(true);
  // Controller players skip the "click to capture the mouse" overlay: they do not need pointer lock.
  if (needClick && !input.forceActive && !input.padActive) $('click').hidden = false;
  else setTimeout(() => { if (G && !input.locked && !input.forceActive && !input.padActive && $('pause').hidden) $('click').hidden = false; }, 900);   // pointer lock request did not succeed
  window.__fl = { get G() { return G; }, input, settings, audio, hud };
  requestAnimationFrame(frame);
}
function openPause() {
  if (!G || G.over) return; G.menuAt = performance.now(); G.paused = true; input.menu = true; input.releaseAll();
  if (G.session.solo) G.session.pause(true);
  input.unlock(); show('pause'); $('click').hidden = true;
}
function resume() {
  if (!G) return; G.menuAt = performance.now(); G.paused = false; input.menu = false; G.session.pause && G.session.pause(false);
  $('settings').hidden = true; show(); input.lock(!document.fullscreenElement);
}
$('bResume').onclick = resume;
$('bClick').onclick = () => { audio.unlock(); input.lock(true); $('click').hidden = true; };

function applyQuality(scale = G.dyn.scale) {
  const q = QUALITY[settings.quality], r = G.renderer;
  G.dyn.base = q.renderScale;
  r.options.dpr = q.dpr; r.options.maxLights = q.maxLights;
  r.setOptions({ renderScale: Math.max(0.25, q.renderScale * scale), bloom: q.bloom && scale >= 0.5, maxLights: q.maxLights });
  r.resize();
}
function vmResize() { const d = Math.min(devicePixelRatio || 1, 2); vmCanvas.width = Math.round(innerWidth * d); vmCanvas.height = Math.round(innerHeight * d); }

// ---------------------------------------------------------------- effects
const nameOf = id => (G.names[id] || 'Player ' + id);
const animOf = id => G.anim[id] || (G.anim[id] = { phase: 0, fireAt: -9, hurtAt: -9, diedAt: -9, alive: true });
function spawnFx(def, x, y, z, now) {
  const f = G.fx[G.fxN = (G.fxN + 1) % G.fx.length];
  f.on = true; f.def = def; f.t0 = now; f.ent.x = x; f.ent.y = y; f.ent.z = z + def.dz; f.ent.fullbright = def.fb;
}
function light(x, y, z, radius, color, intensity, ttl) { G.renderer.addLight({ x, y, z, radius, color, intensity, ttl }); }

function onEvent(e, local) {
  if (local === 'dup') return;
  const me = G.myId, now = G.lastNow / 1000;
  switch (e.t) {
    case 'fire':
      if (local) { G.vmCtx.events.push(e); audio.play(FIRE_SOUND[e.w], undefined, undefined, undefined, 0.95, e.w === 3 ? 1.06 : 1); input.rumble(FIRE_RUMBLE[e.w] || 0.3, 0.5, e.w === 3 ? 40 : 90); }
      else { audio.play(FIRE_SOUND[e.w], e.x, e.y, e.z, 1); light(e.x + 0, e.y, e.z, 240, [1, 0.75, 0.35], 1.3, 0.08); animOf(e.p).fireAt = now; }
      break;
    case 'jump': if (local) { G.vmCtx.events.push(e); audio.play('JUMP', undefined, undefined, undefined, 0.5); } else { const r = G.remotes[e.p]; if (r) audio.play('JUMP', r.x, r.y, r.z, 0.7); } break;
    case 'land': if (local) { G.vmCtx.events.push(e); audio.play('OOF', undefined, undefined, undefined, Math.min(0.7, e.v / 900)); } else { const r = G.remotes[e.p]; if (r) audio.play('OOF', r.x, r.y, r.z, 0.5); } break;
    case 'switch': if (local) { G.vmCtx.events.push(e); audio.play('WPNUP', undefined, undefined, undefined, 0.35); } break;
    case 'explode': {
      const k = e.w === 5 ? FX.plasma : e.w === 6 ? FX.bfg : FX.rocket;
      spawnFx(k, e.x, e.y, e.z, G.lastNow / 1000);
      light(e.x, e.y, e.z, e.w === 5 ? 200 : 360, e.w === 6 ? [0.4, 1, 0.5] : e.w === 5 ? [0.4, 0.55, 1] : [1, 0.6, 0.2], e.w === 5 ? 1.4 : 2.4, e.w === 5 ? 0.18 : 0.4);
      audio.play(e.w === 5 ? 'FIRXPL' : 'RXPLOD', e.x, e.y, e.z, 1);
      break;
    }
    case 'impact': spawnFx(FX.puff, e.x, e.y, e.z, now); break;
    case 'hit': {
      if (e.dmg <= 0) break;   // spawn protection / fully absorbed: no blood, pain flash or sound
      spawnFx(FX.blood, e.x, e.y, e.z, now);
      if (e.target === me) {
        const a = G.remotes[e.p]; hud.damage(e.p !== me && a ? Math.atan2(a.y - G.L.y, a.x - G.L.x) : null, e.dmg);
        audio.play('PLPAIN', undefined, undefined, undefined, 0.9);
        input.rumble(Math.min(1, e.dmg / 40), Math.min(1, e.dmg / 25), 160);
      } else {
        const t = G.remotes[e.target], an = animOf(e.target);
        if (t && now - an.hurtAt > 0.2) audio.play('PLPAIN', t.x, t.y, t.z, 0.9);
        an.hurtAt = now;
      }
      if (e.p === me && e.target !== me && e.dmg > 0) { hud.hit(false); audio.play('TINK', undefined, undefined, undefined, 0.35); }
      break;
    }
    case 'kill': {
      const mine = e.killer === me || e.victim === me;
      hud.feed(e.killer === e.victim || e.killer < 0 ? '' : nameOf(e.killer), (WEAPONS[e.w] || { name: '?' }).name, nameOf(e.victim), mine);
      const v = e.victim === me ? G.L : G.remotes[e.victim];
      if (v) audio.play('PDIEHI', e.victim === me ? undefined : v.x, v.y, v.z, 0.9);
      if (e.killer === me && e.victim !== me) { hud.hit(true); hud.toast('Fragged ' + nameOf(e.victim)); }
      if (e.victim === me) G.killer = e.killer === me ? 'yourself' : nameOf(e.killer);
      animOf(e.victim).diedAt = now;
      break;
    }
    case 'pickup': {   // (the wire format carries only the index; look the rest up)
      const pk = G.session.pickups[e.idx]; if (!pk) break;
      if (e.p === me) { const d = PICKUP_SPRITES[pk.type], it = ITEMS[pk.type]; audio.play(it.weapon !== undefined ? 'WPNUP' : it.power ? 'GETPOW' : 'ITEMUP', undefined, undefined, undefined, 0.8); if (d) hud.toast(d[1]); }
      else audio.play('ITEMUP', pk.x, pk.y, pk.z, 0.6);
      break;
    }
    case 'respawnitem': audio.play('ITMBK', e.x, e.y, e.z, 0.5); spawnFx(FX.itemfog, e.x, e.y, e.z, now); break;
    case 'spawn': spawnFx(FX.tele, e.x, e.y, e.z, now); audio.play('TELEPT', e.x, e.y, e.z, 0.7); animOf(e.p).diedAt = -9; break;
    case 'teleport':
      spawnFx(FX.tele, e.x, e.y, e.z, now); audio.play('TELEPT', e.p === me ? undefined : e.x, e.y, e.z, 0.8);
      if (e.p === me && !e.out) { input.yaw = (((e.yaw % 360) + 360) % 360) * Math.PI / 180; input.pitch = 0; }
      break;
    case 'mover': {   // doors / lifts / floors: a = EVM code (1 open, 2 close, 3/4 lift, 6 floor)
      const snd = e.a === 1 ? 'DOROPN' : e.a === 2 ? 'DORCLS' : e.a === 3 || e.a === 4 ? 'PSTART' : e.a === 6 ? 'STNMOV' : null;
      if (snd) audio.play(snd, e.x, e.y, e.z, 0.75);
      break;
    }
    default: break;
  }
}

// ---------------------------------------------------------------- frame
const _cam = { x: 0, y: 0, z: 0, angle: 0, pitch: 0, fov: 90 };
const WALK = ['A', 'B', 'C', 'D'], DEATH = 'HIJKLMN';
const FIRE_RUMBLE = [0.15, 0.55, 0.8, 0.2, 0.7, 0.25, 1];   // per weapon id: pistol .. BFG

// ---------------------------------------------------------------- controller
// Polled every display frame (registered before the game loop, so the view angle is updated before rendering).
// While menus are up the controller moves focus: D-pad / left stick up-down, A select, B back, left-right adjusts sliders.
let padLast = 0, padNavAt = 0;
function padMenu(pressed, y) {
  const now = performance.now();
  if (!$('click').hidden && (pressed & 1)) { $('click').hidden = true; audio.unlock(); return; }
  const items = [...document.querySelectorAll('.screen:not([hidden]) button, .screen:not([hidden]) input, .screen:not([hidden]) select')]
    .filter(el => el.offsetParent !== null && !el.disabled && el.type !== 'hidden');
  if (!items.length) return;
  let dir = pressed & (1 << 13) ? 1 : pressed & (1 << 12) ? -1 : 0;
  if (!dir && Math.abs(y) > 0.6 && now - padNavAt > 220) dir = Math.sign(y);
  if (dir) {
    padNavAt = now;
    const i = items.indexOf(document.activeElement);
    items[i < 0 ? 0 : (i + dir + items.length) % items.length].focus();
  }
  const el = items.includes(document.activeElement) ? document.activeElement : null;
  const lr = pressed & (1 << 15) ? 1 : pressed & (1 << 14) ? -1 : 0;
  if (el && lr && (el.type === 'range' || el.tagName === 'SELECT')) {
    if (el.type === 'range') el.value = +el.value + lr * (+el.step || 1) * 4;
    else el.selectedIndex = Math.max(0, Math.min(el.options.length - 1, el.selectedIndex + lr));
    el.dispatchEvent(new Event(el.type === 'range' ? 'input' : 'change', { bubbles: true }));
  }
  if (pressed & 1) {
    const target = el || items[0];
    if (target.type === 'checkbox') { target.checked = !target.checked; target.dispatchEvent(new Event('change', { bubbles: true })); }
    else if (target.type !== 'range' && target.tagName !== 'SELECT') target.click();
  }
  if (pressed & 2) {
    if (!$('settings').hidden) $('bSettingsClose').click();
    else if (G && !$('pause').hidden) resume();
  }
}
input.onPadMenu = padMenu;
function padLoop(now) {
  requestAnimationFrame(padLoop);
  const dt = Math.min(0.05, (now - padLast) / 1000 || 0.016); padLast = now;
  input.pollPad(dt);
}
requestAnimationFrame(padLoop);
function frame(now) {
  requestAnimationFrame(frame);
  const g = G; if (!g) return;
  const j0 = performance.now();
  const dtMs = now - g.lastNow || 16.7; g.lastNow = now;
  const s = g.session, cap = settings.fpsCap;
  s.update(now);
  if (cap && now - g.lastRender < 1000 / cap - 1.5) return;     // FPS cap: the sim still ran above
  const dt = Math.min(0.1, (now - g.lastRender) / 1000 || 0.016); const sinceRender = now - g.lastRender; g.lastRender = now;
  if (!s.ready) { hud.center('Connecting...'); return; }
  const alpha = s.alpha(), L = s.local(alpha); if (!L) return;
  g.L = L; const rv = g.remotes = s.remotes(alpha);
  if (!g.yawSet) { input.yaw = L.yaw; input.pitch = 0; g.yawSet = true; g.lastYaw = input.yaw; hud.center(''); }
  const t = now / 1000;

  // ---- events (audio / fx / hud)
  s.drainEvents(onEvent);

  // ---- camera: live mouse angles, interpolated position
  const alive = L.alive;
  if (alive && !g.wasAlive) { g.killer = ''; }
  g.wasAlive = alive;
  const lookDX = angDiff(input.yaw, g.lastYaw), lookDY = input.pitch - g.lastPitch; g.lastYaw = input.yaw; g.lastPitch = input.pitch;
  const vc = g.vmCtx, vp = vc.player;
  vp.x = L.x; vp.y = L.y; vp.z = L.z; vp.eyeZ = L.eyeZ; vp.yaw = input.yaw; vp.pitch = input.pitch;
  vc.speed = Math.hypot(L.vx, L.vy); vc.grounded = L.grounded; vc.sprint = !!input.down.ShiftLeft || input.padSprint; vc.lookDX = lookDX; vc.lookDY = lookDY;
  vc.weapon = L.weapon; vc.wstate = L.wstate; vc.wtimer = L.wtimer; vc.stepOff = L.stepOff;
  const pose = VM.updateViewModel(g.vm, Math.min(dt, 0.05), vc);
  vc.events.length = 0;
  for (const ev of VM.drainViewEvents(g.vm)) if (ev.type === 'muzzle') light(ev.x, ev.y, ev.z, 260, [1, 0.75, 0.35], 1.6, ev.flashSec + 0.04);
  _cam.x = L.x; _cam.y = L.y; _cam.z = alive ? L.eyeZ : L.z + 14; _cam.angle = input.yaw;
  _cam.pitch = Math.max(-1.5, Math.min(1.5, input.pitch + (alive ? pose.camPitch : -0.25))); _cam.fov = settings.fov;
  g.renderer.setCamera(_cam);

  // ---- entities
  const ents = g.ents; ents.length = 0;
  const pickups = s.pickups;
  for (let i = 0; i < pickups.length; i++) if (s.pickupActive(i)) { const e = g.pickupEnts[i]; e.z = e.base + 3 + Math.sin(t * 2.2 + i) * 2; ents.push(e); }
  for (const id in rv) {
    const p = rv[id], an = animOf(id);
    let e = g.pEnt[id]; if (!e) e = g.pEnt[id] = { id: 'p' + id, x: 0, y: 0, z: 0, angle: 0, sprite: 'PLAYA1', fullbright: 0, rotate: true };
    e.x = p.x; e.y = p.y; e.z = p.z; e.angle = p.yaw;
    if (!p.alive) {
      if (an.alive) { an.alive = false; if (an.diedAt < 0) an.diedAt = t; }
      const k = Math.min(DEATH.length - 1, Math.floor((t - an.diedAt) * 9));
      e.sprite = 'PLAY' + DEATH[k] + '0'; e.rotate = false;
    } else {
      an.alive = true; e.rotate = true; const sp = Math.hypot(p.vx, p.vy);
      if (sp > 30 && p.grounded) an.phase += sp * dt * 0.02;
      let f = sp > 30 ? WALK[Math.floor(an.phase) & 3] : 'A';
      if (t - an.fireAt < 0.18) f = 'F'; else if (t - an.hurtAt < 0.2) f = 'G';
      e.sprite = 'PLAY' + f + '1';
    }
    ents.push(e);
  }
  // projectiles (extrapolated from the last snapshot / tick)
  const projs = s.projectiles, age = s.projAge(now, alpha);
  g.lightFrame = (g.lightFrame || 0) + 1;
  for (let i = 0; i < projs.length; i++) {
    const pr = projs[i], def = PROJ[pr.w]; if (!def) continue;
    let e = g.projEnts[i]; if (!e) e = g.projEnts[i] = { id: 'm' + i, x: 0, y: 0, z: 0, angle: 0, sprite: '', fullbright: 1, rotate: true };
    e.x = pr.x + pr.vx * age; e.y = pr.y + pr.vy * age; e.z = pr.z + pr.vz * age + def.dz; e.angle = Math.atan2(pr.vy, pr.vx); e.sprite = def.sprite; e.rotate = def.rot;
    ents.push(e);
    let lt = g.projLights.get(pr.id);
    if (!lt) { lt = { id: g.renderer.addLight({ x: e.x, y: e.y, z: e.z + 8, radius: def.radius, color: def.color, intensity: def.intensity }), f: 0 }; g.projLights.set(pr.id, lt); }
    g.renderer.updateLight(lt.id, { x: e.x, y: e.y, z: e.z + 8 }); lt.f = g.lightFrame;
  }
  for (const [pid, lt] of g.projLights) if (lt.f !== g.lightFrame) { g.renderer.removeLight(lt.id); g.projLights.delete(pid); }
  for (const f of g.fx) {
    if (!f.on) continue;
    const k = Math.floor((t - f.t0) / f.def.dur);
    if (k >= f.def.frames.length) { f.on = false; continue; }
    f.ent.sprite = f.def.frames[k]; ents.push(f.ent);
  }
  g.renderer.setEntities(ents);
  const h = s.heights(); if (h && g.renderer.setSectorHeights) g.renderer.setSectorHeights(h.floors, h.ceils);

  g.renderer.render(dt);

  // ---- viewmodel overlay
  vg.clearRect(0, 0, vmCanvas.width, vmCanvas.height);
  if (alive) VM.drawViewModel(vg, pose, g.sprites, vmCanvas.width, vmCanvas.height, { baseline: -10 });

  // ---- audio listener, HUD, perf
  audio.setListener(L.x, L.y, L.eyeZ, input.yaw, input.pitch);
  hudFrame(g, s, L, rv, dt, t, now, sinceRender);
  g.jsMs += (performance.now() - j0 - g.jsMs) * 0.05;
}

function hudFrame(g, s, L, rv, dt, t, now, sinceRender) {
  const left = g.timeLimit * 60 - s.tick / 60;
  let bestId = g.myId, best = L.frags;
  for (const id in rv) if (rv[id].frags > best) { best = rv[id].frags; bestId = +id; }
  hud.update(L, left, bestId, best, nameOf);
  hud.frame(dt, input.yaw);
  if (!L.alive) { const tenths = Math.ceil(L.respawn / 6); if (g.rt !== tenths) { g.rt = tenths; hud.center('Fragged', (g.killer ? 'by ' + g.killer + '   ' : '') + 'respawn in ' + (tenths / 10).toFixed(1) + 's'); } }
  else if (g.rt !== -1) { g.rt = -1; hud.center(''); }
  if (g.score || g.over) hud.scoreboard(true, rows(g, L, rv), g.over ? 'Final standings' : 'Scoreboard'); else hud.scoreboard(false);
  // perf
  g.frames++; g.fpsN++; g.dyn.frame(sinceRender, now, settings.fpsCap, Math.max(g.renderer.stats().cpuMs || 0, g.renderer.stats().gpuMs || 0));
  if (now - g.fpsT > 500) {
    g.fps = g.fpsN * 1000 / (now - g.fpsT); g.fpsN = 0; g.fpsT = now;
    const st = g.renderer.stats();
    g.fpsText = settings.showFps ? `${g.fps.toFixed(0)} fps  ${(1000 / (g.fps || 1)).toFixed(1)} ms\n${st.renderSize ? st.renderSize.join('x') : ''} @${g.renderer.options.renderScale.toFixed(2)}${s.kind === 'client' ? '\nping ' + s.rtt.toFixed(0) + ' ms' : ''}\njs ${g.jsMs.toFixed(2)} ms` : '';
    hud.fps(g.fpsText);
  }
  if (left <= 0 && !g.over) endMatch(rows(g, L, rv));
  if (s.stalled && !g.over) { g.over = true; input.menu = true; input.releaseAll(); input.unlock(); $('overTitle').textContent = 'Connection lost'; $('overBody').textContent = 'The host is no longer responding.'; show('over'); }
}
function rows(g, L, rv) {
  const out = [{ name: 'You', frags: L.frags, deaths: L.deaths, me: true }];
  for (const id in rv) out.push({ name: nameOf(id), frags: rv[id].frags, deaths: rv[id].deaths, me: false });
  return out.sort((a, b) => b.frags - a.frags || a.deaths - b.deaths);
}
function endMatch(r) {
  G.over = true; input.menu = true; input.releaseAll(); input.unlock(); const w = r[0];
  $('overTitle').textContent = w.me ? 'You win!' : w.name + ' wins';
  $('overBody').textContent = r.map((x, i) => `${i + 1}. ${x.name}  -  ${x.frags} frags / ${x.deaths} deaths`).join('\n'); $('overBody').style.whiteSpace = 'pre-line';
  show('over');
}
document.addEventListener('visibilitychange', () => { if (document.hidden && G && !G.over && G.session.solo) openPause(); });
// background tabs stop rAF; keep multiplayer sessions alive (the host drops silent peers after 10 s)
setInterval(() => { if (document.hidden && G && !G.paused && !G.over && !G.session.solo) G.session.update(performance.now()); }, 500);
document.title = 'Fragline';
window.__fl = window.__fl || { get G() { return G; }, input, settings, audio, hud };
