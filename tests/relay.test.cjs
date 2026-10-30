// Protocol tests for the room relay. The same checks run against both servers:
//   node tests/relay.test.cjs                         (starts lan_server.py)
//   node tests/relay.test.cjs http://127.0.0.1:8787   (e.g. `npm start` for the Cloudflare Worker)
// Needs Node 22+ (built-in WebSocket).
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const freePort = () => new Promise(resolve => {
    const server = net.createServer().listen(0, () => { const {port} = server.address(); server.close(() => resolve(port)); });
});

async function startLanServer() {
    const port = await freePort();
    const child = spawn(process.env.PYTHON || 'python3', [path.join(__dirname, '..', 'lan_server.py'), '--port', String(port)], {stdio: ['ignore', 'pipe', 'ignore']});
    await new Promise((resolve, reject) => {
        child.stdout.on('data', chunk => { if (String(chunk).includes('local game:')) resolve(); });
        child.on('exit', code => reject(new Error(`lan_server.py exited with ${code}`)));
    });
    return {base: `http://127.0.0.1:${port}`, stop: () => child.kill()};
}

let base;
const api = async (route, header = true) => {
    const response = await fetch(`${base}/api/${route}`, {headers: header ? {'X-Fragline': '1'} : {}});
    return {status: response.status, data: await response.json()};
};
const packet = (to, from, text = '') => {
    const body = new TextEncoder().encode(text);
    const bytes = new Uint8Array(8 + body.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, to, true);
    view.setUint32(4, from, true);
    bytes.set(body, 8);
    return bytes.buffer;
};
const decode = data => {
    const view = new DataView(data);
    return {from: view.getUint32(0, true), text: new TextDecoder().decode(new Uint8Array(data, 4))};
};

function open(code) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/ws/${code}`);
        ws.binaryType = 'arraybuffer';
        ws.inbox = [];
        ws.waiters = [];
        ws.closed = new Promise(done => ws.addEventListener('close', event => done({code: event.code, reason: event.reason})));
        ws.addEventListener('message', event => {
            const waiter = ws.waiters.shift();
            if (waiter) waiter(event.data); else ws.inbox.push(event.data);
        });
        ws.addEventListener('open', () => resolve(ws));
        ws.addEventListener('error', () => reject(new Error('connection refused')));
    });
}
const receive = (ws, ms = 3000) => ws.inbox.length ? Promise.resolve(ws.inbox.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no message')), ms);
    ws.waiters.push(data => { clearTimeout(timer); resolve(data); });
});
const closedWith = async (ws, ms = 3000) => Promise.race([ws.closed, new Promise((_, reject) => setTimeout(() => reject(new Error('socket stayed open')), ms))]);
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

function malformedUpgrade(code) {
    const {hostname, port} = new URL(base);
    return new Promise(resolve => {
        const socket = net.connect(Number(port), hostname, () => {
            socket.write(`GET /api/ws/${code} HTTP/1.1\r\nHost: ${hostname}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
        });
        socket.on('data', () => socket.destroy());
        socket.on('close', resolve);
        socket.on('error', resolve);
        setTimeout(() => socket.destroy(), 2000);
    });
}

async function main() {
    // Room creation needs the custom header and clamps the player count.
    assert.equal((await api('newroom', false)).status, 403);
    assert.equal((await api('newroom?players=9')).data.maxPlayers, 4);
    assert.equal((await api('newroom?players=1')).data.maxPlayers, 2);
    assert.equal((await api('room/abcdefgh')).status, 404);
    console.log('ok room creation rules');

    const {room} = (await api('newroom?players=2')).data;
    // Broken handshakes must not use up player slots.
    await malformedUpgrade(room);
    await malformedUpgrade(room);
    const host = await open(room);
    host.send(packet(0, 1));
    const guest = await open(room);
    guest.send(packet(1, 2, 'hello'));
    assert.deepEqual(decode(await receive(host)), {from: 2, text: 'hello'});
    host.send(packet(2, 1, 'welcome'));
    assert.deepEqual(decode(await receive(guest)), {from: 1, text: 'welcome'});
    assert.equal((await api(`room/${room}`)).data.players, 2);
    console.log('ok packets routed between players; failed handshakes leave slots free');

    await assert.rejects(open(room), /refused/);
    console.log('ok full room refuses another player');

    // A second socket claiming an id that is already connected is closed.
    const {room: other} = (await api('newroom?players=3')).data;
    const a = await open(other);
    a.send(packet(0, 5));
    const b = await open(other);
    b.send(packet(0, 5));
    assert.equal((await closedWith(b)).code, 1008);
    a.close();
    console.log('ok duplicate player id rejected');

    // Starting needs the header; afterwards only players from the match may reconnect.
    assert.equal((await api(`room/${room}/start`, false)).status, 403);
    assert.equal((await api(`room/${room}/start`)).data.started, true);
    guest.close();
    await guest.closed;
    await settle(200);
    const stranger = await open(room);
    stranger.send(packet(1, 99));
    assert.equal((await closedWith(stranger)).code, 1008);
    await settle(200);
    const returning = await open(room);
    returning.send(packet(1, 2, 'back'));
    assert.deepEqual(decode(await receive(host)), {from: 2, text: 'back'});
    console.log('ok after start: strangers refused, dropped player reconnects');

    returning.send('not binary');
    assert.equal((await closedWith(returning)).code, 1003);
    host.close();
    console.log('ok invalid packet closes the socket');
    console.log('Relay protocol tests passed');
}

(async () => {
    const server = process.argv[2] ? {base: process.argv[2].replace(/\/$/, ''), stop() {}} : await startLanServer();
    base = server.base;
    try { await main(); } finally { server.stop(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
