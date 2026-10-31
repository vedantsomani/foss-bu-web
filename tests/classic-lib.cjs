// Shared helpers for the Classic (Crispy Doom) engine tests: lan_server.py, headless Chromium
// with software WebGL, and readers/commands for the engine's [fragline] diagnostic exports.
const {spawn} = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const {chromium} = require('playwright');

const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
// fl_state() selectors (engine/crispy-doom/src/doom/fl_api.c)
const S = {tic: 0, gamestate: 1, map: 2, health: 3, weapon: 4, pending: 5, playerstate: 6, leveltime: 7, menu: 8, automap: 9,
    netgame: 10, frags: 11, hasmo: 12, armor: 13, paused: 14, usergame: 15, ammo0: 16, ammo1: 17, ammo2: 18, ammo3: 19,
    x: 20, y: 21, angle: 22, heapUsed: 23, heapArena: 24, lookdir: 25, kills: 26, z: 27, momz: 28,
    buttons: 29, forward: 30, side: 31, turn: 32, arti: 33, look: 34, chat: 35, screenblocks: 36, width: 37, height: 38,
    hires: 39, truecolor: 40, widescreen: 41, crosshair: 42, uncapped: 43, usedown: 44, attackdown: 45, items: 46,
    totalkills: 47, menuItem: 48, owned: 100};
const GS_LEVEL = 0, GS_INTERMISSION = 1;
const WEAPONS = ['fist', 'pistol', 'shotgun', 'chaingun', 'rocket launcher', 'plasma rifle', 'BFG 9000', 'chainsaw', 'super shotgun'];

const freePort = () => new Promise(resolve => {
    const server = net.createServer().listen(0, () => { const {port} = server.address(); server.close(() => resolve(port)); });
});

async function startServer() {
    if (process.env.BASE_URL) return {base: process.env.BASE_URL.replace(/\/$/, ''), stop() {}};
    const port = await freePort();
    const child = spawn(process.env.PYTHON || 'python3', [path.join(__dirname, '..', 'lan_server.py'), '--port', String(port)], {stdio: ['ignore', 'pipe', 'inherit']});
    await new Promise((resolve, reject) => {
        child.stdout.on('data', chunk => { if (String(chunk).includes('local game:')) resolve(); });
        child.on('exit', code => reject(new Error(`lan_server.py exited with ${code}`)));
    });
    return {base: `http://127.0.0.1:${port}`, stop: () => child.kill()};
}

const launch = () => chromium.launch({args: ARGS});

// Every uncaught error and engine abort ends up in page.errors.
async function newPage(browser, {viewport = {width: 960, height: 600}, settings = {}, context} = {}) {
    const ctx = context || await browser.newContext({viewport});
    const page = await ctx.newPage();
    page.errors = [];
    page.engineLog = [];
    page.on('pageerror', error => page.errors.push(error.message));
    page.on('console', message => {
        const text = message.text();
        if (message.type() === 'error' && !/favicon|Failed to load resource/.test(text)) page.errors.push(text);
        if (process.env.DEBUG) console.log(`[page] ${text}`);
    });
    // Engine output is only echoed in ?debug mode; collect it so tests can assert on it.
    await page.addInitScript(values => {
        try { for (const [k, v] of Object.entries(values)) localStorage.setItem(`fragline-${k}`, String(v)); } catch { /* storage unavailable */ }
    }, settings);
    return page;
}

// Start "Practice alone" on a map and wait until the level is running.
async function startPractice(page, base, {map = 1, query = '?debug', timeout = 90000} = {}) {
    await page.goto(`${base}/${query}`);
    await page.click('#new-match');
    await page.selectOption('#match-map', String(map));
    await page.click('#practice');
    await page.waitForSelector('#panel', {state: 'hidden', timeout});
    await waitLevel(page, {timeout});
}

const fl = (page, what) => page.evaluate(n => Module._fl_state(n), what);
const flCommand = (page, what, arg = 0) => page.evaluate(([w, a]) => Module._fl_command(w, a), [what, arg]);
const flMany = (page, names) => page.evaluate(([list]) => Object.fromEntries(list.map(([k, n]) => [k, Module._fl_state(n)])), [names.map(k => [k, S[k]])]);

async function waitLevel(page, {minTics = 5, timeout = 60000} = {}) {
    await page.waitForFunction(([n, level]) => typeof Module._fl_state === 'function' && Module._fl_state(1) === level
        && Module._fl_state(7) >= n, [minTics, GS_LEVEL], {timeout, polling: 100});
}

async function waitTics(page, tics, timeout = 60000) {
    const start = await fl(page, S.tic);
    await page.waitForFunction(([from, n]) => Module._fl_state(0) >= from + n, [start, tics], {timeout, polling: 100});
}

// Type a Doom cheat the way a player would. (Movement keys are pressed too, as on a real keyboard.)
async function cheat(page, code) {
    await page.focus('#canvas');
    for (const ch of code) { await page.keyboard.press(ch); await waitTics(page, 2); }
}

// Mouse look: headless Chromium reports movementX as 0 under pointer lock, so send the events ourselves.
const mouseMove = (page, dx, dy) => page.evaluate(([x, y]) => document.getElementById('canvas')
    .dispatchEvent(new MouseEvent('mousemove', {bubbles: true, movementX: x, movementY: y})), [dx, dy]);

const heapBytes = page => page.evaluate(() => Module.HEAPU8.length);

module.exports = {ARGS, S, GS_LEVEL, GS_INTERMISSION, WEAPONS, startServer, launch, newPage, startPractice, fl, flCommand, flMany,
    waitLevel, waitTics, cheat, mouseMove, heapBytes, freePort};
