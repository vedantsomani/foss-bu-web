// demo.js - Fragline render lab demo. Query: ?map=MAP07 &scale=0.5 &classic=1 &bloom=0 &fov=100 &cam=x,y,z,angleDeg,pitchDeg
//                                              &bench=1 &frames=300 &things=0
import { fetchWad, parseMap, pointInSector } from '../wad.js';
import { createRenderer } from './renderer.js';

const q = new URLSearchParams(location.search);
const canvas = document.getElementById('c');
const hud = document.getElementById('hud');
const msg = document.getElementById('msg');
const mapName = (q.get('map') || 'MAP01').toUpperCase();
const bench = q.get('bench') === '1';

async function main() {
  const t0 = performance.now();
  const wad = await fetchWad('../../freedm.wad.gz');
  const map = parseMap(wad, mapName);
  const tWad = performance.now() - t0;
  const opts = {
    renderScale: parseFloat(q.get('scale') || '1'),
    classic: q.get('classic') === '1',
    bloom: q.get('bloom') !== '0',
    fov: parseFloat(q.get('fov') || '90'),
    things: q.get('things') !== '0',
    clipZ: q.get('clipz') ? parseFloat(q.get('clipz')) : 1e9,
    syncTiming: bench,
    preserveDrawingBuffer: q.get('shot') === '1',
  };
  if (q.get('dpr')) opts.dpr = parseFloat(q.get('dpr'));
  if (q.get('fog')) opts.fogDensity = parseFloat(q.get('fog'));
  if (q.get('ambient')) opts.ambient = parseFloat(q.get('ambient'));
  const t1 = performance.now();
  const r = createRenderer(canvas, wad, map, opts);
  const tBuild = performance.now() - t1;
  msg.remove();

  const start = map.things.find((t) => t.type === 1) || map.things.find((t) => t.type === 11) || { x: 0, y: 0, angle: 0 };
  const cam = { x: start.x, y: start.y, z: 41, angle: start.angle * Math.PI / 180, pitch: 0, fov: opts.fov };
  const floorAt = (x, y) => { const s = pointInSector(map, x, y); return s >= 0 ? map.sectors[s].floor : 0; };
  cam.z = floorAt(cam.x, cam.y) + 41;
  if (q.get('cam')) {
    const [x, y, z, a, p] = q.get('cam').split(',').map(Number);
    Object.assign(cam, { x, y, z: Number.isFinite(z) ? z : floorAt(x, y) + 41, angle: (a || 0) * Math.PI / 180, pitch: (p || 0) * Math.PI / 180 });
  }
  window.__demo = { renderer: r, cam, map, tWad, tBuild };

  // ---- input
  const keys = new Set();
  let fly = q.get('fly') === '1' || !!q.get('cam') && q.get('cam').split(',').length > 2;
  addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (e.code === 'KeyF') fly = !fly;
    if (e.code === 'Digit1') r.setOptions({ classic: !r.options.classic });
    if (e.code === 'Digit2') r.setOptions({ bloom: !r.options.bloom });
    if (e.code === 'Digit3') r.setOptions({ renderScale: Math.max(0.25, r.options.renderScale / 1.5) });
    if (e.code === 'Digit4') r.setOptions({ renderScale: Math.min(2, r.options.renderScale * 1.5) });
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  canvas.addEventListener('click', () => { if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.(); else fire(); });
  addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    cam.angle -= e.movementX * 0.0022;
    cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch - e.movementY * 0.0022));
  });
  function fire() {
    const dx = Math.cos(cam.angle), dy = Math.sin(cam.angle);
    r.addLight({ x: cam.x + dx * 24, y: cam.y + dy * 24, z: cam.z, radius: 260, color: [1, 0.75, 0.35], intensity: 1.6, ttl: 0.12 });
    rockets.push({ x: cam.x + dx * 20, y: cam.y + dy * 20, z: cam.z - 6, dx, dy, light: r.addLight({ x: cam.x, y: cam.y, z: cam.z, radius: 220, color: [1, 0.5, 0.15], intensity: 1.2 }), life: 1.5 });
  }
  const rockets = [];

  // ---- bench path: tour of the deathmatch starts
  const stops = map.things.filter((t) => t.type === 11 || t.type === 1).map((t) => ({ x: t.x, y: t.y }));
  if (stops.length < 2) stops.push({ x: cam.x + 100, y: cam.y });
  const N = parseInt(q.get('frames') || '300', 10);
  function benchPose(i) {
    const f = (i / N) * stops.length;
    const a = stops[Math.floor(f) % stops.length], b = stops[(Math.floor(f) + 1) % stops.length];
    const t = f - Math.floor(f);
    const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
    const ang = Math.atan2(b.y - a.y, b.x - a.x) + Math.sin(i * 0.05) * 0.5;
    return { x, y, z: floorAt(x, y) + 41, angle: ang, pitch: Math.sin(i * 0.03) * 0.15 };
  }

  // ---- loop
  const frameMs = [], cpuMs = [], syncMs = [], gpuMs = [];
  let last = performance.now(), fpsT = last, fpsN = 0, fps = 0, frame = 0;
  const hist = [];
  function tick(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    const interval = now - last;
    last = now;
    if (bench) {
      if (frame > 0) frameMs.push(interval);
      Object.assign(cam, benchPose(frame));
    } else {
      const sp = (keys.has('ShiftLeft') ? 420 : 210) * dt;
      const f = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
      const s = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
      const ca = Math.cos(cam.angle), sa = Math.sin(cam.angle);
      cam.x += (ca * f + sa * s) * sp; cam.y += (sa * f - ca * s) * sp;
      if (fly) {
        cam.z += ((keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0)) * sp;
      } else {
        const target = floorAt(cam.x, cam.y) + 41;
        cam.z += (target - cam.z) * Math.min(1, dt * 14);
      }
      if (keys.has('ArrowLeft')) cam.angle += 2 * dt;
      if (keys.has('ArrowRight')) cam.angle -= 2 * dt;
      for (let i = rockets.length - 1; i >= 0; i--) {
        const k = rockets[i];
        k.x += k.dx * 700 * dt; k.y += k.dy * 700 * dt; k.life -= dt;
        r.updateLight(k.light, { x: k.x, y: k.y, z: k.z });
        if (k.life <= 0 || pointInSector(map, k.x, k.y) < 0) {
          r.removeLight(k.light);
          r.addLight({ x: k.x, y: k.y, z: k.z, radius: 320, color: [1, 0.6, 0.2], intensity: 2.2, ttl: 0.35 });
          rockets.splice(i, 1);
        }
      }
      r.setEntities(rockets.map((k, i) => ({ id: 'r' + i, x: k.x, y: k.y, z: k.z - 8, sprite: 'MISLA1', fullbright: true })).concat(window.__extraEnts || []));
    }
    r.setCamera(cam);
    r.render(dt);
    const st = r.stats();
    if (bench && frame > 0) { cpuMs.push(st.cpuMs); syncMs.push(st.syncMs); if (st.gpuMs != null) gpuMs.push(st.gpuMs); }
    frame++; fpsN++;
    if (now - fpsT >= 500) { fps = fpsN * 1000 / (now - fpsT); fpsN = 0; fpsT = now; }
    hist.push(interval); if (hist.length > 120) hist.shift();
    const avg = hist.reduce((a, b) => a + b, 0) / hist.length;
    hud.textContent = `${mapName}  ${fps.toFixed(0)} fps  frame ${avg.toFixed(2)} ms (worst ${Math.max(...hist).toFixed(1)})\n`
      + `cpu ${st.cpuMs.toFixed(2)} ms  gpu ${st.gpuMs == null ? 'n/a' : st.gpuMs.toFixed(2) + ' ms'}\n`
      + `draws ${st.drawCalls}  tris ${st.triangles}  sectors ${st.visibleSectors}  sprites ${st.sprites}\n`
      + `internal ${st.renderSize[0]}x${st.renderSize[1]}  scale ${r.options.renderScale.toFixed(2)}  ${r.options.classic ? 'classic' : 'modern'}${r.options.bloom ? ' bloom' : ''}`;
    if (bench && frame > N) { finishBench(); return; }
    requestAnimationFrame(tick);
  }

  function pct(a, p) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }
  const avgOf = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  function finishBench() {
    const st = r.stats();
    window.benchResult = {
      map: mapName, frames: frameMs.length, renderSize: st.renderSize, canvas: [canvas.width, canvas.height],
      wadParseMs: tWad, buildMs: tBuild,
      frameIntervalMs: { avg: avgOf(frameMs), p95: pct(frameMs, 0.95), max: Math.max(...frameMs) },
      cpuMs: { avg: avgOf(cpuMs), p95: pct(cpuMs, 0.95) },
      cpuPlusFinishMs: /* gl.finish() may not block in Chromium's GPU-process model; treat as ~cpu */ { avg: avgOf(syncMs), p95: pct(syncMs, 0.95) },
      gpuTimerMs: gpuMs.length ? { avg: avgOf(gpuMs), p95: pct(gpuMs, 0.95), samples: gpuMs.length } : null, // EXT_disjoint_timer_query (software GL here) drawCalls: st.drawCalls, triangles: st.triangles, info: r.info(),
    };
    hud.textContent = 'bench done ' + JSON.stringify(window.benchResult.cpuPlusFinishMs);
  }
  requestAnimationFrame((t) => { last = t; tick(t); });
}

main().catch((e) => { console.error(e); msg.textContent = 'error: ' + e.message; window.demoError = String(e.stack || e); });
