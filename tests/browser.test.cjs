// End-to-end check in headless Chromium: page loads cleanly, a host creates a room in the
// UI, guests join by link, and every browser reaches a running match.
// Usage: node tests/browser.test.cjs [baseURL] [players]
//   With no baseURL it starts lan_server.py on a free port. Needs Playwright + Chromium.
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const {chromium} = require('playwright');

const freePort = () => new Promise(resolve => {
    const server = net.createServer().listen(0, () => { const {port} = server.address(); server.close(() => resolve(port)); });
});

async function startLanServer() {
    const port = await freePort();
    const child = spawn(process.env.PYTHON || 'python3', [path.join(__dirname, '..', 'lan_server.py'), '--port', String(port)], {stdio: ['ignore', 'pipe', 'inherit']});
    await new Promise((resolve, reject) => {
        child.stdout.on('data', chunk => { if (String(chunk).includes('local game:')) resolve(); });
        child.on('exit', code => reject(new Error(`lan_server.py exited with ${code}`)));
    });
    return {base: `http://127.0.0.1:${port}`, stop: () => child.kill()};
}

async function openPage(browser, url, errors) {
    const page = await (await browser.newContext()).newPage();
    page.on('pageerror', error => errors.push(`${url}: ${error.message}`));
    if (process.env.DEBUG) page.on('console', m => console.log(`[${url.slice(-9)}] ${m.text()}`));
    await page.goto(process.env.DEBUG ? `${url}?debug` : url);
    return page;
}

(async () => {
    const players = Number(process.argv[3] || 2);
    const server = process.argv[2] ? {base: process.argv[2].replace(/\/$/, ''), stop() {}} : await startLanServer();
    const browser = await chromium.launch();
    const errors = [];
    try {
        const host = await openPage(browser, server.base + '/', errors);
        assert.equal((await host.textContent('.brand')).trim(), 'FRAGLINE');
        await host.fill('#player-name', 'Host Player');
        await host.click('#new-match');
        await host.selectOption('#match-players', String(players));
        await host.selectOption('#match-map', '7');
        await host.click('#create-room');
        await host.waitForFunction(() => /^[A-Z2-9]{8}$/.test(document.getElementById('lobby-code').textContent), null, {timeout: 15000});
        const code = (await host.textContent('#lobby-code')).toLowerCase();
        assert.equal(await host.inputValue('#lobby-link'), `${server.base}/${code}`);
        await host.waitForSelector('#loader', {state: 'hidden', timeout: 90000});
        await host.waitForFunction(n => document.getElementById('lobby-count').textContent === `1 of ${n} players connected`, players, {timeout: 30000});
        console.log(`room ${code} created; host engine connected to the relay`);

        const guests = [];
        for (let i = 1; i < players; i++) {
            const guest = await openPage(browser, `${server.base}/${code}`, errors);
            await guest.waitForSelector('#screen-join:not([hidden])', {timeout: 15000});
            await guest.fill('#join-name', `Guest ${i}`);
            await guest.click('#join-room');
            guests.push(guest);
        }
        for (const page of [host, ...guests]) await page.waitForSelector('#panel', {state: 'hidden', timeout: 90000});
        console.log(`${players}-player match started in every browser`);
        if (process.env.SCREENSHOT) await host.locator('#canvas').screenshot({path: process.env.SCREENSHOT});

        const late = await openPage(browser, `${server.base}/${code}`, errors);
        await late.waitForSelector('#screen-message:not([hidden])', {timeout: 15000});
        assert.match(await late.textContent('#message-title'), /already started/i);
        const missing = await openPage(browser, `${server.base}/abcdefgh`, errors);
        await missing.waitForSelector('#screen-message:not([hidden])', {timeout: 15000});
        assert.match(await missing.textContent('#message-title'), /not found/i);
        console.log('late join and unknown room show clear messages');

        // Pasting a whole invite link into the code box works, and a full room says so.
        const pasted = await openPage(browser, server.base + '/', errors);
        await pasted.fill('#room-code', `${server.base}/${code}`);
        await pasted.press('#room-code', 'Enter');
        await pasted.waitForSelector('#screen-message:not([hidden])', {timeout: 15000});
        assert.match(await pasted.textContent('#message-title'), /already started/i);
        const bad = await openPage(browser, server.base + '/', errors);
        await bad.fill('#room-code', 'nope');
        await bad.click('#join-form button');
        assert.match(await bad.textContent('#room-error'), /8-character/);

        // Settings survive a reload and reach the engine's config files.
        const prefs = await openPage(browser, server.base + '/', errors);
        await prefs.click('#open-settings');
        await prefs.click('#tab-controls');
        await prefs.locator('label:has(#controller-enabled)').click();
        await prefs.click('#screen-settings .seg-btn:has-text("Large")');
        await prefs.reload();
        assert.equal(await prefs.isChecked('#controller-enabled'), false);
        assert.equal(await prefs.inputValue('#controller-deadzone'), '0.4');
        const cfg = await prefs.evaluate(() => (window.fraglineConfigs || (() => ({})))());
        assert.match(cfg['extra.cfg'] || '', /use_gamepad\s+0/);
        assert.match(cfg['extra.cfg'] || '', /joystick_x_dead_zone\s+40/);

        // Leaving a lobby goes home without a "leave site?" prompt and stops the room from starting a game.
        const leaver = await openPage(browser, server.base + '/', errors);
        leaver.on('dialog', dialog => { errors.push('unexpected dialog ' + dialog.type()); dialog.dismiss(); });
        await leaver.click('#new-match');
        await leaver.click('#create-room');
        await leaver.waitForSelector('#screen-lobby:not([hidden])', {timeout: 15000});
        await leaver.click('#screen-lobby [data-home]');
        await leaver.waitForSelector('#screen-home:not([hidden])', {timeout: 15000});
        console.log('pasted link, settings persistence and leaving a lobby work');

        const solo = await openPage(browser, server.base + '/', errors);
        await solo.click('#new-match');
        await solo.selectOption('#match-map', '5');
        await solo.click('#practice');
        await solo.waitForSelector('#panel', {state: 'hidden', timeout: 90000});
        assert.ok(await solo.evaluate(() => document.body.classList.contains('in-match')));
        console.log('practice mode starts');

        assert.deepEqual(errors, [], 'no page errors');
        console.log('Browser end-to-end test passed');
    } finally {
        await browser.close();
        server.stop();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
