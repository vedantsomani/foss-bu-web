// Fragline room relay on Cloudflare Workers + Durable Objects.
// Packet routing follows Cloudflare's BSD-licensed multiplayer Doom router; the rules
// below match lan_server.py so one browser client works against both servers.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE = /^[a-hjkmnp-z2-9]{8}$/;
const ROOM_TTL = 12 * 60 * 60 * 1000;
const IDLE_TIMEOUT = 60 * 1000;
const MIN_PLAYERS = 2, MAX_PLAYERS = 4;
const API_HEADER = 'X-Fragline';

function newCode() {
  // Rejection sampling keeps every character equally likely.
  let code = '';
  while (code.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 248 && code.length < 8) code += ALPHABET[byte % ALPHABET.length];
    }
  }
  return code;
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

// State-changing calls need a custom header, which browsers will not send cross-site
// without CORS permission and link prefetchers never send.
const trusted = request => request.headers.get(API_HEADER) === '1';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.split('/').filter(Boolean);
    if (path[0] !== 'api') {
      // Static files are served before the Worker runs; only room links reach here.
      if (path.length === 1 && CODE.test(path[0])) return env.ASSETS.fetch(new Request(new URL('/', url), request));
      return env.ASSETS.fetch(request);
    }
    if (path[1] === 'newroom' && path.length === 2) {
      if (!trusted(request)) return json({ error: 'Missing header' }, 403);
      if (env.ROOM_LIMITER) {
        const { success } = await env.ROOM_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
        if (!success) return json({ error: 'Too many rooms created. Wait a minute and try again.' }, 429);
      }
      const players = Math.min(Math.max(parseInt(url.searchParams.get('players'), 10) || 2, MIN_PLAYERS), MAX_PLAYERS);
      for (let attempt = 0; attempt < 3; attempt++) {
        const code = newCode();
        const stub = env.router.get(env.router.idFromName(code));
        const response = await stub.fetch('https://room.internal/init', { method: 'POST', body: JSON.stringify({ players }) });
        if (response.ok) return json({ room: code, maxPlayers: players });
        if (response.status !== 409) break;
      }
      return json({ error: 'Could not create a room' }, 503);
    }
    if ((path[1] === 'room' || path[1] === 'ws') && CODE.test(path[2] || '')) {
      return env.router.get(env.router.idFromName(path[2])).fetch(request);
    }
    return json({ error: 'Invalid room' }, 404);
  },
};

export class Router {
  constructor(ctx) {
    this.ctx = ctx;
    this.meta = undefined;
    this.sockets = new Map(); // WebSocket -> { uid, last }
    this.players = new Map(); // uid -> WebSocket
    this.known = new Set(); // uids that have been in this room
    this.sweeper = null;
  }

  async room() {
    if (this.meta === undefined) this.meta = (await this.ctx.storage.get('meta')) || null;
    if (this.meta && Date.now() - this.meta.created > ROOM_TTL) return null;
    return this.meta;
  }

  status(code) {
    return { room: code, started: this.meta.started, players: this.players.size, maxPlayers: this.meta.max };
  }

  async fetch(request) {
    const path = new URL(request.url).pathname.split('/').filter(Boolean);
    if (path[0] === 'init' && request.method === 'POST') {
      if (await this.room()) return new Response('exists', { status: 409 });
      const { players } = await request.json();
      this.meta = { created: Date.now(), started: false, max: players };
      await this.ctx.storage.put('meta', this.meta);
      await this.ctx.storage.setAlarm(this.meta.created + ROOM_TTL);
      return new Response('ok');
    }
    const meta = await this.room();
    if (!meta) return json({ error: 'Room not found or expired' }, 404);
    if (path[1] === 'room') {
      if (path[3] === 'start' && path.length === 4) {
        if (!trusted(request)) return json({ error: 'Missing header' }, 403);
        if (!meta.started) {
          meta.started = true;
          await this.ctx.storage.put('meta', meta);
        }
      } else if (path.length > 3) {
        return json({ error: 'Not found' }, 404);
      }
      return json(this.status(path[2]));
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 400);
    if (this.sockets.size >= meta.max) return json({ error: 'Room is full' }, 409);
    if (meta.started && this.known.size <= this.players.size) return json({ error: 'Match already started' }, 409);
    const [client, socket] = Object.values(new WebSocketPair());
    socket.accept();
    this.attach(socket);
    return new Response(null, { status: 101, webSocket: client });
  }

  attach(socket) {
    const session = { uid: null, last: Date.now() };
    this.sockets.set(socket, session);
    let count = 0, epoch = Date.now();
    socket.addEventListener('message', event => {
      const now = Date.now();
      session.last = now;
      if (now - epoch > 1000) { count = 0; epoch = now; }
      if (++count > 500) return socket.close(1008, 'Message limit');
      const data = event.data;
      if (!(data instanceof ArrayBuffer) || data.byteLength < 8 || data.byteLength > 65536) return socket.close(1003, 'Invalid packet');
      const view = new DataView(data);
      const to = view.getUint32(0, true), from = view.getUint32(4, true);
      if (session.uid === null) {
        const holder = this.players.get(from);
        if (holder && holder !== socket) return socket.close(1008, 'Duplicate player');
        // After the match starts only players who were in it may come back.
        if (this.meta.started && !this.known.has(from)) return socket.close(1008, 'Match already started');
        session.uid = from;
        this.players.set(from, socket);
        this.known.add(from);
      } else if (session.uid !== from) {
        return socket.close(1008, 'Invalid identity');
      }
      const target = this.players.get(to);
      if (target) {
        try { target.send(data.slice(4)); } catch { /* receiver is closing; its close handler cleans up */ }
      }
    });
    socket.addEventListener('close', event => {
      // Answer the client's close frame, otherwise its socket hangs half-closed.
      try { socket.close(event.code === 1005 ? 1000 : event.code, 'Closed'); } catch {}
      this.drop(socket);
    });
    socket.addEventListener('error', () => this.drop(socket));
    // Close sockets that stop sending so they cannot hold a player slot forever.
    this.sweeper ??= setInterval(() => {
      const cutoff = Date.now() - IDLE_TIMEOUT;
      for (const [ws, s] of this.sockets) {
        if (s.last >= cutoff) continue;
        try { ws.close(1001, 'Idle'); } catch {}
        this.drop(ws);
      }
    }, 15000);
  }

  drop(socket) {
    const session = this.sockets.get(socket);
    if (!session) return;
    this.sockets.delete(socket);
    if (session.uid !== null && this.players.get(session.uid) === socket) this.players.delete(session.uid);
    if (!this.sockets.size && this.sweeper) { clearInterval(this.sweeper); this.sweeper = null; }
  }

  async alarm() {
    for (const ws of this.sockets.keys()) { try { ws.close(1001, 'Room expired'); } catch {} }
    this.sockets.clear();
    this.players.clear();
    if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = null; }
    await this.ctx.storage.deleteAll();
    this.meta = null;
  }
}
