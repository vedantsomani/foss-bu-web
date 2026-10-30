// transport.js - packet transport abstraction.
// An "endpoint" has: uid, send(to, Uint8Array payload), onPacket = (from, Uint8Array) => {}, close().
// Two implementations: MemoryNetwork (deterministic, virtual clock, latency/jitter/loss/reorder) and
// RelayTransport (the existing Fragline WebSocket relay: [u32 to][u32 from][payload], little endian).

function mulberry(seed) {
  let s = seed >>> 0;
  return () => { let t = (s += 0x6D2B79F5) >>> 0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export class MemoryNetwork {
  // latency/jitter are ONE-WAY milliseconds; loss is 0..1 per packet. Per-direction overrides via setLink(from,to,conf).
  constructor({ latency = 0, jitter = 0, loss = 0, seed = 1, reorder = true } = {}) {
    this.conf = { latency, jitter, loss };
    this.links = new Map();
    this.rng = mulberry(seed);
    this.reorder = reorder;
    this.now = 0;
    this.queue = []; // {at, seq, from, to, data}
    this.n = 0;
    this.endpoints = new Map();
    this.stats = { sent: 0, dropped: 0, delivered: 0, bytes: 0 };
  }
  set(conf) { Object.assign(this.conf, conf); }
  setLink(from, to, conf) { this.links.set(from + '>' + to, { ...this.conf, ...conf }); }
  endpoint(uid) {
    const net = this;
    const ep = {
      uid, onPacket: null,
      send(to, payload) { net.send(uid, to, payload); },
      close() { net.endpoints.delete(uid); },
    };
    this.endpoints.set(uid, ep);
    return ep;
  }
  send(from, to, payload) {
    const c = this.links.get(from + '>' + to) || this.conf;
    this.stats.sent++; this.stats.bytes += payload.length;
    if (this.rng() < c.loss) { this.stats.dropped++; return; }
    let delay = c.latency + (c.jitter ? (this.rng() * 2 - 1) * c.jitter : 0);
    if (delay < 0) delay = 0;
    let at = this.now + delay;
    if (!this.reorder) { // keep FIFO per link, like TCP
      const key = from + '>' + to; const last = this._last?.get(key) ?? 0; at = Math.max(at, last); (this._last ||= new Map()).set(key, at);
    }
    this.queue.push({ at, seq: this.n++, from, to, data: payload.slice() });
  }
  // advance the virtual clock and deliver everything due, in arrival order
  update(nowMs) {
    this.now = nowMs;
    if (!this.queue.length) return;
    this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
    let i = 0;
    for (; i < this.queue.length && this.queue[i].at <= nowMs; i++) {
      const m = this.queue[i], ep = this.endpoints.get(m.to);
      this.stats.delivered++;
      if (ep && ep.onPacket) ep.onPacket(m.from, m.data);
    }
    this.queue.splice(0, i);
  }
}

export class RelayTransport {
  // url like ws://host:port/api/ws/<ROOM>. Relay forwards [from][payload] (it strips the 'to' word).
  constructor(url, uid, WS = globalThis.WebSocket) {
    this.uid = uid; this.onPacket = null; this.onOpen = null; this.onClose = null; this.open = false;
    this.ws = new WS(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => { this.open = true; this.onOpen && this.onOpen(); };
    this.ws.onclose = e => { this.open = false; this.onClose && this.onClose(e); };
    this.ws.onerror = () => {};
    this.ws.onmessage = ev => {
      const d = new Uint8Array(ev.data);
      if (d.length < 4) return;
      const from = new DataView(d.buffer, d.byteOffset).getUint32(0, true);
      this.onPacket && this.onPacket(from, d.subarray(4));
    };
  }
  send(to, payload) {
    if (!this.open) return;
    const b = new Uint8Array(8 + payload.length), v = new DataView(b.buffer);
    v.setUint32(0, to, true); v.setUint32(4, this.uid, true); b.set(payload, 8);
    this.ws.send(b);
  }
  // host announces itself by sending to uid 0 (relay registers the sender's uid; nobody receives it)
  announce() { this.send(0, new Uint8Array([72])); }
  close() { try { this.ws.close(); } catch {} }
}
