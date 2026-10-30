// Headless Playwright smoke test for public/lab/game/index.html. Run: node public/lab/tests/smoke.pw.mjs [outDir]
// Starts lan_server.py on a private port, drives the page with real keyboard/mouse, asserts no page errors, takes screenshots.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const out = process.argv[2] || '/tmp/claude-0/-home-user-foss-bu-web/c9b9e5c9-e2a3-5291-9cb2-929773db5740/scratchpad/agentB';
const PORT = 8814, sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn('python3', ['/home/user/foss-bu-web/lan_server.py', '--port', String(PORT)], { stdio: 'ignore' });
let code = 0;
try {
  for (let i = 0; i < 50; i++) { await sleep(100); try { if ((await fetch(`http://127.0.0.1:${PORT}/lab/game/index.html`)).ok) break; } catch {} }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('requestfailed', r => errors.push('requestfailed: ' + r.url()));
  await page.goto(`http://127.0.0.1:${PORT}/lab/game/index.html`);
  await page.waitForFunction(() => window.__ready === true && window.__fragline.client.me, null, { timeout: 15000 });
  // drive with real input: move, aim, fire, switch weapon, jump
  await page.mouse.move(900, 300);
  await page.keyboard.down('KeyW'); await page.keyboard.down('ShiftLeft');
  await page.mouse.down(); await sleep(1500);
  await page.keyboard.press('Space'); await page.keyboard.press('Digit3'); await sleep(1500);
  await page.mouse.move(400, 500); await sleep(800);
  await page.screenshot({ path: path.join(out, 'smoke-lat75.png') });
  // high latency + loss
  await page.evaluate(() => { const l = document.getElementById('lat'); l.value = 250; l.dispatchEvent(new Event('input')); const p = document.getElementById('loss'); p.value = 15; p.dispatchEvent(new Event('input')); });
  await sleep(3000);
  await page.mouse.up(); await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');
  await page.screenshot({ path: path.join(out, 'smoke-lat250-loss15.png') });
  await page.evaluate(() => { const l = document.getElementById('lat'); l.value = 0; l.dispatchEvent(new Event('input')); const p = document.getElementById('loss'); p.value = 0; p.dispatchEvent(new Event('input')); const j = document.getElementById('jit'); j.value = 0; j.dispatchEvent(new Event('input')); });
  await sleep(2500);
  const info = await page.evaluate(() => { const f = window.__fragline, c = f.client, h = f.host.world.players[2]; return { source: f.mapSource, tick: f.host.world.tick, snaps: c.stats.snapshots, corrections: c.stats.corrections, maxCorr: c.stats.maxCorrection, err: Math.hypot(c.me.x - h.x, c.me.y - h.y), sprites: f.sprites ? Object.keys(f.sprites).length : 0, weapon: c.me.weapon, frags: Object.values(f.host.world.players).map(p => p.frags), pending: c.pending.length }; });
  await page.screenshot({ path: path.join(out, 'smoke-lat0.png') });
  console.log('smoke info', JSON.stringify(info));
  if (errors.length) { console.log('ERRORS', errors); code = 1; }
  if (info.snaps < 100 || info.sprites < 20) { console.log('FAIL: insufficient activity'); code = 1; }
  if (info.err > 1) { console.log('FAIL: predicted != authoritative', info.err); code = 1; }
  await browser.close();
} catch (e) { console.log('smoke failure', e); code = 1; }
finally { try { srv.kill('SIGTERM'); } catch {} }
console.log(code ? 'SMOKE FAILED' : 'SMOKE OK (no page errors)');
process.exit(code);
