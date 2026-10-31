// lobby.js - room API + pre-match lobby over the relay. Lobby packets share the relay with the game protocol:
// type 1 = HELLO (client -> host, repeated), 20 = LOBBY (host -> clients, JSON), 21 = START (host -> clients, JSON).
import { RelayTransport } from '../net/transport.js';
import { MSG } from '../net/protocol.js';

const LOBBY = 20, START = 21, H = { 'X-Fragline': '1' };
const enc = new TextEncoder(), dec = new TextDecoder();
const pack = (type, obj) => { const j = enc.encode(JSON.stringify(obj)), b = new Uint8Array(1 + j.length); b[0] = type; b.set(j, 1); return b; };
const unpack = d => JSON.parse(dec.decode(d.subarray(1)));
const wsUrl = code => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws/${code}`;

export async function newRoom(players) {
  const r = await fetch(`/api/newroom?players=${players}`, { headers: H });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not create room');
  return (await r.json()).room;
}
export async function roomStatus(code) {
  const r = await fetch(`/api/room/${code}`, { headers: H });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Room not found');
  return r.json();
}
export const startRoom = code => fetch(`/api/room/${code}/start`, { headers: H }).then(r => { if (!r.ok) throw new Error('Could not start'); });
export const roomLink = code => `${location.origin}${location.pathname}?room=${code}`;

export class HostLobby {
  constructor(code, cfg) {
    this.code = code; this.cfg = cfg; this.joined = new Map(); this.onChange = null; this.onError = null; this.open = false;
    const t = this.t = new RelayTransport(wsUrl(code), 1);
    t.onOpen = () => { this.open = true; t.announce(); this.changed(); };
    t.onClose = () => { if (!this.started) this.onError && this.onError('Connection to the room was lost'); };
    t.onPacket = (from, d) => {
      if (d[0] !== MSG.HELLO) return;
      const fresh = !this.joined.has(from);
      this.joined.set(from, performance.now());
      if (fresh) this.changed();
    };
    this.timer = setInterval(() => {
      let drop = false;
      for (const [id, at] of this.joined) if (performance.now() - at > 3500) { this.joined.delete(id); drop = true; }
      if (drop) this.changed(); else this.broadcast();
    }, 1000);
  }
  get ids() { return [1, ...this.joined.keys()].sort((a, b) => a - b); }
  changed() { this.broadcast(); this.onChange && this.onChange(this.ids); }
  broadcast() { const m = pack(LOBBY, { ...this.cfg, ids: this.ids }); for (const id of this.joined.keys()) this.t.send(id, m); }
  async start(extra = {}) {
    await startRoom(this.code);
    this.started = true; clearInterval(this.timer);
    const m = pack(START, { ...this.cfg, ...extra, ids: this.ids });
    for (const id of this.joined.keys()) { this.t.send(id, m); setTimeout(() => this.t.send(id, m), 300); }
    return [...this.joined.keys()];
  }
  close() { clearInterval(this.timer); this.t.close(); }
}

export class ClientLobby {
  constructor(code, { onUpdate, onStart, onError }) {
    this.code = code; this.onUpdate = onUpdate; this.onStart = onStart; this.onError = onError; this.closed = false; this.got = false; this.lastLobby = performance.now();
    this.watch = setInterval(() => {   // the host broadcasts every second; silence means it left
      if (this.got && !this.started && !this.closed && performance.now() - this.lastLobby > 6000) { this.close(); this.onError('The host left the room'); }
    }, 1000);
    this.connect(2);
  }
  connect(uid) {
    this.uid = uid;
    const t = this.t = new RelayTransport(wsUrl(this.code), uid);
    const hello = () => t.send(1, new Uint8Array([MSG.HELLO]));
    t.onOpen = () => { hello(); this.hb = setInterval(hello, 500); };
    t.onPacket = (from, d) => {
      if (from !== 1) return;
      if (d[0] === LOBBY) { this.got = true; this.lastLobby = performance.now(); this.onUpdate(unpack(d)); }
      else if (d[0] === START && !this.started) { this.started = true; clearInterval(this.hb); clearInterval(this.watch); this.onStart(unpack(d), t, uid); }
    };
    t.onClose = e => {
      clearInterval(this.hb);
      if (this.closed || this.started) return;
      if (e && e.code === 1008 && !this.got && uid < 4) { this.connect(uid + 1); return; }   // uid already taken by another player
      this.onError(e && e.reason ? e.reason : this.got ? 'Disconnected from the room' : 'Could not join the room (full, started or expired)');
    };
  }
  close() { this.closed = true; clearInterval(this.hb); clearInterval(this.watch); this.t.close(); }
}
