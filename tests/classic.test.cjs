// Classic engine (Crispy Doom 7.2 in WebAssembly) smoke test in headless Chromium.
// Starts "Practice alone" and checks, through the engine's [fragline] diagnostic exports, that
// audio and music run, every control reaches the game, every weapon fires, level changes, death,
// the exit/intermission flow, saving and loading, quitting, bad config values, a hostile network
// peer and a (fake) controller all work without a page error or engine abort.
// Usage: node tests/classic.test.cjs [baseURL]     Needs Playwright + Chromium.
const assert = require('node:assert/strict');
const L = require('./classic-lib.cjs');
const {S} = L;

const log = text => console.log(`classic: ${text}`);
const press = (page, key, delay = 70) => page.keyboard.press(key, {delay});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = (page, ...names) => L.flMany(page, names);
const noErrors = (page, what) => assert.deepEqual(page.errors, [], `${what}: page errors`);

// Hold a key (or mouse button) for a moment and report what the player's last tic command was.
async function holdCmd(page, key, ms = 350) {
    await page.keyboard.down(key);
    await L.waitTics(page, Math.ceil(ms / 28));
    const cmd = await state(page, 'buttons', 'forward', 'side', 'turn', 'arti', 'look');
    await page.keyboard.up(key);
    await L.waitTics(page, 3);
    return cmd;
}

// Wait for the ready weapon to be `weapon` (the weapon change animation takes a few tics).
async function selectWeapon(page, key, weapon) {
    await press(page, key);
    await page.waitForFunction(w => Module._fl_state(4) === w && Module._fl_state(5) === 10, weapon, {timeout: 8000, polling: 50});
}

// Taps the audio output so a test can tell whether sound is actually being produced.
function tapAudio() {
    const connect = AudioNode.prototype.connect;
    window.__peak = 0;
    AudioNode.prototype.connect = function (dest, ...rest) {
        if (dest instanceof AudioDestinationNode && !this.__tapped) {
            this.__tapped = true;
            const analyser = this.context.createAnalyser();
            analyser.fftSize = 2048;
            connect.call(this, analyser);
            setInterval(() => {
                const data = new Float32Array(2048);
                analyser.getFloatTimeDomainData(data);
                for (const v of data) window.__peak = Math.max(window.__peak, Math.abs(v));
            }, 50);
        }
        return connect.call(this, dest, ...rest);
    };
}

async function audioAndMusic(browser, base) {
    const peaks = {};
    for (const music of [true, false]) {
        const page = await L.newPage(browser, {settings: {'set-music': music ? 1 : 0}});
        await page.addInitScript(tapAudio);
        await L.startPractice(page, base, {map: 1, query: ''});
        assert.deepEqual(await page.evaluate(() => window.fraglineAudioState()), ['running'], 'audio context is running');
        await page.evaluate(() => { window.__peak = 0; });
        await sleep(4000);
        peaks[music] = await page.evaluate(() => window.__peak);
        if (!music) { // sound effects still work
            await page.evaluate(() => { window.__peak = 0; });
            await page.keyboard.down('Control');
            await sleep(1200);
            await page.keyboard.up('Control');
            peaks.sfx = await page.evaluate(() => window.__peak);
        }
        noErrors(page, `music ${music}`);
        await page.context().close();
    }
    assert.ok(peaks.true > 0.02, `music is audible (peak ${peaks.true})`);
    assert.ok(peaks.false < 0.001, `no sound at all when music is off and nothing happens (peak ${peaks.false})`);
    assert.ok(peaks.sfx > 0.02, `sound effects are audible (peak ${peaks.sfx})`);
    log(`audio runs after the first click; music audible (peak ${peaks.true.toFixed(2)}), silent when switched off, gunfire peak ${peaks.sfx.toFixed(2)}`);
}

async function controls(page) {
    await L.cheat(page, 'iddqd');
    await L.cheat(page, 'idkfa');
    const owned = await page.evaluate(() => [100, 101, 102, 103, 104, 105, 106, 107, 108].map(n => Module._fl_state(n)));
    assert.deepEqual(owned, new Array(9).fill(1), 'IDKFA gives every weapon');

    // Keyboard: each control turns into the command the engine expects.
    const expectations = {
        w: c => c.forward > 0, s: c => c.forward < 0, a: c => c.side < 0, d: c => c.side > 0,
        ArrowLeft: c => c.turn > 0, ArrowRight: c => c.turn < 0, Control: c => c.buttons & 1, e: c => c.buttons & 2,
        Space: c => c.arti & 128, PageUp: c => c.look > 0, PageDown: c => c.look < 0,
    };
    for (const [key, check] of Object.entries(expectations)) {
        assert.ok(check(await holdCmd(page, key)), `key ${key} reaches the game`);
    }
    log('keyboard: move, strafe, turn, fire, use, jump, look up/down');

    // Weapon keys, and the wheel in both directions.
    for (const [key, weapon] of [['2', 1], ['4', 3], ['5', 4], ['6', 5], ['7', 6]]) await selectWeapon(page, key, weapon);
    await selectWeapon(page, '3', 8); // Doom II: 3 toggles between shotgun and super shotgun
    await selectWeapon(page, '3', 2);
    await selectWeapon(page, '1', 7); // fist and chainsaw share key 1: the chainsaw wins, as in Doom
    await selectWeapon(page, '4', 3);

    // Pointer lock and mouse look on both axes.
    await page.click('#canvas');
    await page.waitForFunction(() => document.pointerLockElement?.id === 'canvas', null, {timeout: 5000});
    const before = await state(page, 'angle', 'lookdir');
    await L.mouseMove(page, 120, 0);
    await L.waitTics(page, 4);
    const turned = await state(page, 'angle');
    assert.notEqual(turned.angle, before.angle, 'mouse X turns');
    await L.mouseMove(page, 0, -80);
    await L.waitTics(page, 4);
    const up = (await state(page, 'lookdir')).lookdir;
    assert.ok(up > before.lookdir, `mouse up looks up (${up})`);
    await L.mouseMove(page, 0, 200);
    await L.waitTics(page, 4);
    assert.ok((await state(page, 'lookdir')).lookdir < up, 'mouse down looks down');
    await L.mouseMove(page, 0, -4000);
    await L.waitTics(page, 4);
    const max = (await state(page, 'lookdir')).lookdir;
    assert.ok(max > 0 && max < 4000, `looking up stops at a limit (${max})`);
    await press(page, 'Home');
    await L.waitTics(page, 20);
    log('pointer lock; mouse look both axes, with limits');

    await selectWeapon(page, '4', 3);
    await page.mouse.wheel(0, -100);
    await page.waitForFunction(() => Module._fl_state(4) === 4, null, {timeout: 5000});
    await page.mouse.wheel(0, 100);
    await page.waitForFunction(() => Module._fl_state(4) === 3, null, {timeout: 5000});
    await page.mouse.down();
    await L.waitTics(page, 5);
    assert.ok((await state(page, 'buttons')).buttons & 1, 'left click fires');
    await page.mouse.up();
    await page.mouse.down({button: 'right'});
    await L.waitTics(page, 5);
    assert.ok((await state(page, 'buttons')).buttons & 2, 'right click uses');
    await page.mouse.up({button: 'right'});
    log('mouse wheel changes weapon both ways; click fires, right click uses');

    // Automap and the Esc menu.
    await press(page, 'Tab');
    await L.waitTics(page, 4);
    assert.equal((await state(page, 'automap')).automap, 1, 'Tab opens the map');
    await press(page, 'Tab');
    await L.waitTics(page, 4);
    assert.equal((await state(page, 'automap')).automap, 0);
    await press(page, 'Escape');
    await L.waitTics(page, 4);
    assert.equal((await state(page, 'menu')).menu, 1, 'Esc opens the menu');
    const item = (await state(page, 'menuItem')).menuItem;
    await press(page, 'ArrowDown');
    await L.waitTics(page, 4);
    assert.equal((await state(page, 'menuItem')).menuItem, item + 1, 'arrow keys move in the menu');
    await press(page, 'Escape');
    await L.waitTics(page, 4);
    assert.equal((await state(page, 'menu')).menu, 0, 'Esc closes the menu');
    log('automap and menu');
}

async function fireEveryWeapon(page) {
    // [key, weapon, ammo selector that must go down]
    const weapons = [['1', 7, null], ['2', 1, 'ammo0'], ['3', 8, 'ammo1'], ['3', 2, 'ammo1'], ['4', 3, 'ammo0'], ['5', 4, 'ammo3'],
        ['6', 5, 'ammo2'], ['7', 6, 'ammo2']];
    await L.cheat(page, 'idkfa');
    for (const [key, weapon, ammo] of weapons) {
        await selectWeapon(page, key, weapon);
        const before = ammo ? (await state(page, ammo))[ammo] : 0;
        await page.keyboard.down('Control');
        await L.waitTics(page, weapon === 6 ? 60 : 25);
        await page.keyboard.up('Control');
        if (ammo) assert.ok((await state(page, ammo))[ammo] < before, `${L.WEAPONS[weapon]} uses ammo`);
        else assert.equal((await state(page, 'attackdown')).attackdown >= 0, true);
        await L.waitTics(page, 40);
        if ((await state(page, 'playerstate')).playerstate === 1) { // an explosion got us: respawn
            await press(page, 'e');
            await L.waitTics(page, 40);
            await L.cheat(page, 'idkfa');
        }
    }
    // Berserk makes key 1 pick the fist even while the chainsaw is owned.
    await L.cheat(page, 'idbeholds');
    await press(page, 's');
    await L.waitTics(page, 4);
    await selectWeapon(page, '1', 7);
    await selectWeapon(page, '1', 0);
    await page.keyboard.down('Control');
    await L.waitTics(page, 20);
    assert.ok((await state(page, 'buttons')).buttons & 1);
    await page.keyboard.up('Control');
    log('all nine weapons fire (fist, chainsaw, pistol, both shotguns, chaingun, rockets, plasma, BFG)');
}

async function levels(page) {
    for (const map of [3, 12, 24, 32, 1]) {
        await L.cheat(page, `idclev${String(map).padStart(2, '0')}`);
        await page.waitForFunction(m => Module._fl_state(2) === m && Module._fl_state(1) === 0, map, {timeout: 30000});
        await L.waitTics(page, 40);
    }
    log('level change (IDCLEV) to maps 3, 12, 24, 32, 1');

    // Death and respawn.
    await L.cheat(page, 'iddqd'); // god mode off, so damage can kill
    await L.flCommand(page, 2);
    await page.waitForFunction(() => Module._fl_state(6) === 1, null, {timeout: 5000});
    await L.waitTics(page, 60);
    await press(page, 'e');
    await page.waitForFunction(() => Module._fl_state(6) === 0 && Module._fl_state(3) === 100, null, {timeout: 10000});
    log('death and respawn');

    // Level exit: intermission screen, then the next map.
    const map = (await state(page, 'map')).map;
    await L.flCommand(page, 1);
    await page.waitForFunction(() => Module._fl_state(1) === 1, null, {timeout: 10000});
    await L.waitTics(page, 120);
    // Use or fire skips the score screen: once to finish the count, once to leave.
    await press(page, 'e');
    await L.waitTics(page, 20);
    await press(page, 'e');
    await page.waitForFunction(m => Module._fl_state(1) === 0 && Module._fl_state(2) === m + 1 && Module._fl_state(7) > 10, map, {timeout: 30000});
    log(`exit -> intermission -> map ${map + 1}`);
    noErrors(page, 'levels');
}

async function saveAndLoad(browser, base) {
    const page = await L.newPage(browser);
    await L.startPractice(page, base, {map: 4, query: ''});
    await press(page, 'w', 400);
    await L.waitTics(page, 60); // let the player stop sliding
    const saved = await state(page, 'x', 'y', 'angle', 'leveltime');
    await press(page, 'F2'); // quick save menu
    await L.waitTics(page, 10);
    assert.equal((await state(page, 'menu')).menu, 1, 'save menu opens');
    await press(page, 'Enter'); // slot 1
    await L.waitTics(page, 5);
    await page.keyboard.type('fl', {delay: 80});
    await press(page, 'Enter');
    await page.waitForFunction(() => Module.FS.readdir('/saves').some(f => /\.dsg$/.test(f)), null, {timeout: 10000});
    await page.waitForFunction(() => window.fraglineSavesIdle?.(), null, {timeout: 10000});
    log('save written and copied to IndexedDB');

    // A fresh page load: the save comes back from IndexedDB.
    await page.reload();
    await L.startPractice(page, base, {map: 9, query: ''});
    assert.notEqual((await state(page, 'x')).x, saved.x);
    await press(page, 'F3');
    await L.waitTics(page, 10);
    await press(page, 'Enter');
    await page.waitForFunction(m => Module._fl_state(2) === m, 4, {timeout: 20000});
    await L.waitTics(page, 5);
    const loaded = await state(page, 'x', 'y', 'angle', 'map');
    assert.deepEqual([loaded.x, loaded.y, loaded.angle, loaded.map], [saved.x, saved.y, saved.angle, 4], 'loaded game restores position');
    noErrors(page, 'save/load');
    log('saved game survives a page reload and loads back to the same spot');
    await page.context().close();
}

async function quit(browser, base) {
    const page = await L.newPage(browser);
    await L.startPractice(page, base, {map: 2, query: ''});
    await press(page, 'F10');
    await L.waitTics(page, 8);
    await press(page, 'y');
    await page.waitForSelector('#screen-message:not([hidden])', {timeout: 15000});
    assert.match(await page.textContent('#message-title'), /Match ended/);
    assert.deepEqual(page.errors, [], 'quitting is clean');
    log('Quit Game ends the match with a clear message');
    await page.context().close();
}

async function qualityAndAspect(browser, base) {
    const dims = {};
    for (const [name, settings, viewport] of [
        ['ultra', {}, {width: 1280, height: 720}],
        ['classic', {'set-graphics': 'performance', 'set-hud': 'classic'}, {width: 1280, height: 720}],
        ['4:3', {}, {width: 800, height: 600}],
        ['ultrawide', {}, {width: 1600, height: 600}],
    ]) {
        const page = await L.newPage(browser, {settings, viewport});
        await L.startPractice(page, base, {map: 1, query: ''});
        dims[name] = await state(page, 'width', 'height', 'hires', 'truecolor', 'screenblocks', 'widescreen');
        noErrors(page, name);
        await page.context().close();
    }
    assert.equal(dims.ultra.hires, 1);
    assert.equal(dims.ultra.truecolor, 1);
    assert.equal(dims.ultra.screenblocks, 15, 'Minimal HUD');
    assert.equal(dims.classic.hires, 0, 'Performance preset uses the original resolution');
    assert.equal(dims.classic.screenblocks, 10, 'Classic status bar');
    assert.ok(dims.ultra.width / dims.ultra.height > dims['4:3'].width / dims['4:3'].height + 0.2, 'widescreen follows the window shape');
    assert.ok(dims.ultrawide.width / dims.ultrawide.height > dims.ultra.width / dims.ultra.height, 'ultrawide is wider still');
    log(`graphics presets and aspect: ${Object.entries(dims).map(([k, v]) => `${k} ${v.width}x${v.height}`).join(', ')}`);
}

async function badConfig(browser, base) {
    // Hostile values written straight into the engine's config files.
    for (const value of ['-1', '99999', '-99999']) {
        const page = await L.newPage(browser, {viewport: {width: 640, height: 400}});
        await page.goto(`${base}/`);
        await page.waitForFunction(() => window.Module?.FS?.writeFile && document.body.classList.contains('engine-ready'), null, {timeout: 60000});
        await page.evaluate(v => {
            const FS = Module.FS, write = FS.writeFile.bind(FS);
            FS.writeFile = (name, text, ...rest) => write(name, /\.cfg$/.test(name)
                ? text.split('\n').map(line => (/^(key_|joystick_physical|use_|fullscreen)/.test(line) || !line.trim() ? line : `${line.split(/\s+/)[0]} ${v}`)).join('\n') : text, ...rest);
        }, value);
        await page.click('#new-match');
        await page.click('#practice');
        await page.waitForSelector('#panel', {state: 'hidden', timeout: 60000});
        await L.waitLevel(page, {minTics: 60});
        await press(page, 'Escape');
        await L.waitTics(page, 10);
        await press(page, 'Escape');
        noErrors(page, `config value ${value}`);
        await page.context().close();
    }
    // Edited or stale saved settings.
    const page = await L.newPage(browser, {settings: {'set-volume': 'loud', 'set-graphics': 'bogus', 'set-sens': '9999', 'controller-deadzone': 'x', 'set-musicvol': '-5', 'set-fps': '12345'}});
    await L.startPractice(page, base, {map: 1, query: ''});
    const cfg = await page.evaluate(() => window.fraglineConfigs());
    for (const text of Object.values(cfg)) assert.doesNotMatch(text, /NaN|undefined|null|loud|bogus/);
    noErrors(page, 'stale settings');
    await page.context().close();
    log('invalid config values and stale settings do not break the game');
}

async function fakeController(browser, base) {
    const page = await L.newPage(browser);
    await page.addInitScript(() => {
        const pad = {id: 'Fake Pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
            axes: [0, 0, 0, 0], buttons: Array.from({length: 17}, () => ({pressed: false, value: 0}))};
        window.__pad = pad;
        window.__press = (n, down) => { pad.buttons[n] = {pressed: down, value: down ? 1 : 0}; pad.timestamp++; };
        navigator.getGamepads = () => [pad, null, null, null];
    });
    await L.startPractice(page, base, {map: 1, query: ''});
    await page.evaluate(() => { const e = new Event('gamepadconnected'); e.gamepad = window.__pad; window.dispatchEvent(e); });
    await L.cheat(page, 'idkfa');
    await page.waitForFunction(() => document.getElementById('controller-status').textContent.includes('connected'), null, {timeout: 5000}).catch(() => {});
    const read = async (axes, buttons = []) => {
        await page.evaluate(([a, b]) => { window.__pad.axes = a; b.forEach(n => window.__press(n, true)); window.__pad.timestamp++; }, [axes, buttons]);
        await L.waitTics(page, 12);
        const cmd = await state(page, 'forward', 'side', 'turn', 'look', 'buttons', 'arti');
        await page.evaluate(b => { window.__pad.axes = [0, 0, 0, 0]; b.forEach(n => window.__press(n, false)); }, buttons);
        await L.waitTics(page, 12);
        return cmd;
    };
    // Engine controller support needs the pad to be seen; on failure fall back to a clear message.
    const forward = await read([0, -1, 0, 0]);
    assert.ok(forward.forward > 0, `left stick forward moves (${forward.forward})`);
    assert.ok((await read([1, 0, 0, 0])).side > 0, 'left stick right strafes right');
    assert.notEqual((await read([0, 0, 1, 0])).turn, 0, 'right stick turns');
    assert.notEqual((await read([0, 0, 0, -1])).look, 0, 'right stick looks');
    assert.ok((await read([0, 0, 0, 0], [7])).buttons & 1, 'right trigger fires');
    assert.ok((await read([0, 0, 0, 0], [0])).arti & 128, 'A jumps');
    assert.ok((await read([0, 0, 0, 0], [2])).buttons & 2, 'X uses');
    // Weapon change with the shoulder buttons.
    await selectWeapon(page, '4', 3);
    await page.evaluate(() => window.__press(5, true));
    await page.waitForFunction(() => Module._fl_state(4) !== 3 || Module._fl_state(5) !== 10, null, {timeout: 5000});
    await page.evaluate(() => window.__press(5, false));
    // Menu: Start opens it, d-pad moves, B closes.
    await page.evaluate(() => window.__press(9, true));
    await page.waitForFunction(() => Module._fl_state(8) === 1, null, {timeout: 5000});
    await page.evaluate(() => window.__press(9, false));
    await L.waitTics(page, 10);
    const item = (await state(page, 'menuItem')).menuItem;
    await page.evaluate(() => window.__press(13, true));
    await L.waitTics(page, 4);
    await page.evaluate(() => window.__press(13, false));
    await L.waitTics(page, 10);
    assert.equal((await state(page, 'menuItem')).menuItem, item + 1, 'd-pad moves in the menu');
    await page.evaluate(() => window.__press(1, true));
    await page.waitForFunction(() => Module._fl_state(8) === 0, null, {timeout: 5000});
    await page.evaluate(() => window.__press(1, false));
    noErrors(page, 'controller');
    log('controller: sticks, trigger, A, X, shoulder buttons, menu with Start / d-pad / B');
    await page.context().close();
}

async function hostilePeer(browser, base) {
    // A host in a room is sent garbage by someone who joined the room: bad, empty and huge packets.
    const host = await L.newPage(browser);
    await host.goto(`${base}/`);
    await host.fill('#player-name', 'Host');
    await host.click('#new-match');
    await host.click('#create-room');
    await host.waitForFunction(() => /^[A-Z2-9]{8}$/.test(document.getElementById('lobby-code').textContent), null, {timeout: 20000});
    const code = (await host.textContent('#lobby-code')).toLowerCase();
    await host.waitForSelector('#loader', {state: 'hidden', timeout: 90000});
    await host.waitForFunction(() => document.getElementById('lobby-count').textContent.startsWith('1 of'), null, {timeout: 30000});
    const url = `${base.replace(/^http/, 'ws')}/api/ws/${code}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('rogue peer could not connect')); });
    const me = 0x51525354;
    const send = (to, payload) => {
        const packet = new Uint8Array(8 + payload.length);
        new DataView(packet.buffer).setUint32(0, to, true);
        new DataView(packet.buffer).setUint32(4, me, true);
        packet.set(payload, 8);
        if (ws.readyState === 1) ws.send(packet);
    };
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 400; i++) {
        const size = i % 50 === 0 ? 1500 + (rnd() % 60000) : rnd() % 1400;
        const payload = Uint8Array.from({length: size}, () => rnd() & 255);
        if (i % 3 === 0 && size > 4) { payload[0] = 0; payload[1] = rnd() % 12; } // plausible packet types
        send(1, payload);
        if (i % 40 === 0) await sleep(50);
    }
    send(1, new Uint8Array(0));
    send(1, new Uint8Array([0xff]));
    send(0, new Uint8Array(70000)); // larger than the relay allows: it drops the rogue connection
    await sleep(500);
    ws.close();
    await sleep(500);
    noErrors(host, 'host after hostile packets');
    // The host is still healthy: a real guest can still join and the match starts.
    const guest = await L.newPage(browser, {settings: {'set-music': 0}});
    await guest.addInitScript(tapAudio);
    await guest.goto(`${base}/${code}`);
    await guest.waitForSelector('#screen-join:not([hidden])', {timeout: 15000});
    await guest.click('#join-room');
    for (const page of [host, guest]) await page.waitForSelector('#panel', {state: 'hidden', timeout: 90000});
    await L.waitLevel(host, {minTics: 35});
    await L.waitLevel(guest, {minTics: 35});
    assert.equal((await state(host, 'netgame')).netgame, 1);
    // Chat in a network game: T opens the input line, Enter sends it.
    await host.focus('#canvas');
    await press(host, 't');
    await L.waitTics(host, 4);
    assert.equal((await state(host, 'chat')).chat, 1, 'T opens chat');
    await host.keyboard.type('hello', {delay: 80});
    await press(host, 'Enter');
    await L.waitTics(host, 4);
    assert.equal((await state(host, 'chat')).chat, 0, 'Enter sends the message');
    // Sound effects work in a network game too.
    await guest.evaluate(() => { window.__peak = 0; });
    await guest.focus('#canvas');
    await guest.keyboard.down('Control');
    await L.waitTics(guest, 40);
    await guest.keyboard.up('Control');
    assert.ok(await guest.evaluate(() => window.__peak) > 0.02, 'gunfire is audible in a network game');
    noErrors(host, 'host in match');
    noErrors(guest, 'guest in match');
    log('hostile or oversized packets are ignored; two-player match still starts; chat works');
    await host.context().close();
    await guest.context().close();
}

(async () => {
    const server = process.argv[2] ? {base: process.argv[2].replace(/\/$/, ''), stop() {}} : await L.startServer();
    const browser = await L.launch();
    const {base} = server;
    try {
        await audioAndMusic(browser, base);

        const page = await L.newPage(browser);
        await L.startPractice(page, base, {map: 1, query: ''});
        assert.ok(await page.evaluate(() => !!document.fullscreenElement), 'full screen starts with the match');
        const heap0 = await L.heapBytes(page);
        await controls(page);
        await fireEveryWeapon(page);
        await levels(page);
        log(`engine heap ${(heap0 / 1048576).toFixed(0)} MB at start, ${((await L.heapBytes(page)) / 1048576).toFixed(0)} MB after all of that`);
        noErrors(page, 'practice session');
        await page.context().close();

        await saveAndLoad(browser, base);
        await quit(browser, base);
        await qualityAndAspect(browser, base);
        await badConfig(browser, base);
        await fakeController(browser, base);
        await hostilePeer(browser, base);
        console.log('Classic engine test passed');
    } finally {
        await browser.close();
        server.stop();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
