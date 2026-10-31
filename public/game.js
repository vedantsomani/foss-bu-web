/* Fragline browser client: downloads, menus, settings, rooms and engine start-up. */
'use strict';
(() => {
    const VERSION = '2.0.2';
    // Sizes are the bytes sent over the wire; tests/static.test.cjs keeps them in sync.
    const DOWNLOADS = [
        {file: 'websockets-doom.wasm.gz', bytes: 760246, wasm: true},
        {file: 'freedm.wad.gz', bytes: 8513298, as: 'freedm.wad'},
        {file: 'fragline.wad', bytes: 213981, as: 'fragline.wad'},
    ];
    const MAPS = ['Tech Test', 'Natural Station', 'Issues of Claveria', 'Steel', 'Dense Fields', 'Temple of Ammon',
        'Main Stronghold', 'Artifact Base', 'Industrial Outland', 'Detached Grounds', 'Isolated Facility',
        "Up 'n' Down Canyon", 'Unholy Blood', 'Technical Assault', 'Shallow Complex', 'Barren Alleys', 'Underwoods',
        'Deserted Courtyard', 'Tech Isle', 'Warehouse', 'Refinery', 'Military Depot', 'Confrontation', 'Flooded Base',
        'Mansion Yard', 'Acidic Crypt', 'The Exile', 'Weapons Factory', 'Unusual Territory', 'Last Man Standing',
        'Desolated Fort', 'Fourplay'];
    const CODE = /^[a-hjkmnp-z2-9]{8}$/;
    const ADJECTIVES = ['Grumpy', 'Crafty', 'Alert', 'Sluggish', 'Testy', 'Manic', 'Patient', 'Furious', 'Laid-Back',
        'Sneaky', 'Rowdy', 'Jumpy', 'Stoic', 'Feral', 'Lucky', 'Cranky', 'Hasty', 'Brave', 'Sly', 'Chaotic'];
    const NOUNS = ['Imp', 'Demon', 'Baron', 'Knight', 'Revenant', 'Spectre', 'Golem', 'Lich', 'Sentinel', 'Reaver',
        'Marine', 'Gunner', 'Raider', 'Wraith', 'Hunter', 'Rocketeer', 'Brawler', 'Drifter', 'Warden', 'Nomad'];

    // Graphics presets map onto Crispy Doom's renderer options.
    const PRESETS = {
        ultra: {crispy_hires: 1, crispy_truecolor: 1, crispy_smoothlight: 1, crispy_brightmaps: 3, crispy_translucency: 3, crispy_coloredblood: 1},
        high: {crispy_hires: 1, crispy_truecolor: 0, crispy_smoothlight: 1, crispy_brightmaps: 3, crispy_translucency: 3, crispy_coloredblood: 1},
        performance: {crispy_hires: 0, crispy_truecolor: 0, crispy_smoothlight: 0, crispy_brightmaps: 0, crispy_translucency: 1, crispy_coloredblood: 0},
    };
    // Every setting the Settings screen edits: element id -> default value.
    const SETTINGS = {
        'set-graphics': 'ultra', 'set-fps': '0', 'set-hud': 'minimal', 'set-crosshair': true, 'set-showfps': false,
        'set-sens': '5', 'set-look': '5', 'set-invert': false, 'set-autorun': true,
        'set-sound': true, 'set-volume': '10', 'set-music': true, 'set-musicvol': '8', 'set-fullscreen': true,
        'controller-enabled': true, 'controller-deadzone': '0.25',
    };

    const $ = id => document.getElementById(id);
    const relayMeta = document.querySelector('meta[name="fragline-relay"]')?.content.trim();
    const relay = (relayMeta || location.origin).replace(/\/$/, '');
    const wsRelay = relay.replace(/^http/, 'ws');
    const store = {
        get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
        set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
    };
    const debug = new URLSearchParams(location.search).has('debug');

    const state = {room: null, host: false, started: false, running: false, poll: null, token: 0};

    // ---------- Screens and messages ----------

    function show(screen) {
        for (const el of document.querySelectorAll('#panel > .screen')) el.hidden = el.id !== `screen-${screen}`;
        $('panel').hidden = false;
        document.body.dataset.screen = screen;
        const focusable = $(`screen-${screen}`).querySelector('[autofocus], button, input, select');
        focusable?.focus({preventScroll: true});
    }

    function fail(title, detail) {
        stopPolling();
        exitImmersive();
        document.exitPointerLock?.();
        $('click-play').hidden = true;
        $('message-title').textContent = title;
        $('message-text').textContent = detail || '';
        show('message');
        window.removeEventListener('beforeunload', confirmLeave);
    }

    let toastTimer = null;
    function toast(text, ms = 4000) {
        const el = $('toast');
        el.textContent = text;
        el.dataset.kind = /drop|lost|fail|not available|could not/i.test(text) ? 'warn' : /copied|reconnected/i.test(text) ? 'ok' : '';
        el.hidden = false;
        el.style.animation = 'none';
        void el.offsetWidth; // restart the slide-in
        el.style.animation = '';
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.hidden = true; }, ms);
    }

    function setLobbyStatus(text) { $('lobby-status').textContent = text; }

    // ---------- Player name and settings ----------

    const randomName = () => `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${NOUNS[Math.floor(Math.random() * NOUNS.length)]}`;
    const cleanName = value => value.replace(/[^0-9a-z \-!]/gi, '').slice(0, 20);

    function playerName() {
        const field = $('player-name');
        const name = cleanName(field.value).trim() || randomName();
        field.value = name;
        store.set('fragline-name', name);
        return name;
    }

    function setting(id) {
        const el = $(id);
        return el.type === 'checkbox' ? el.checked : el.value;
    }

    function bindSettings() {
        $('player-name').value = cleanName(store.get('fragline-name', '')) || randomName();
        for (const id of ['player-name', 'join-name']) $(id).addEventListener('input', e => { e.target.value = cleanName(e.target.value); });
        $('random-name').addEventListener('click', () => { $('player-name').value = randomName(); });
        for (const [id, fallback] of Object.entries(SETTINGS)) {
            const el = $(id);
            const saved = store.get(`fragline-${id}`, null);
            if (el.type === 'checkbox') el.checked = saved === null ? fallback : saved === '1';
            else el.value = saved ?? fallback;
            if (el.tagName === 'SELECT' && el.selectedIndex < 0) el.value = fallback; // stale or edited storage
            const save = () => {
                store.set(`fragline-${id}`, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
                renderSettingValues();
            };
            el.addEventListener(el.type === 'range' ? 'input' : 'change', save);
        }
        renderSettingValues();
        const map = $('match-map');
        MAPS.forEach((name, i) => map.add(new Option(`${String(i + 1).padStart(2, '0')} · ${name}`, String(i + 1))));
        for (const id of ['match-map', 'match-players', 'match-time', 'match-mode']) {
            const field = $(id);
            field.value = store.get(`fragline-${id}`, field.value);
            if (field.selectedIndex < 0) field.selectedIndex = 0;
            field.addEventListener('change', () => store.set(`fragline-${id}`, field.value));
        }
    }

    function renderSettingValues() {
        for (const el of document.querySelectorAll('input[type=range]')) {
            const out = document.querySelector(`output[for="${el.id}"]`);
            if (out) out.textContent = el.value;
            el.style.setProperty('--fill', `${(el.value - el.min) / (el.max - el.min) * 100}%`);
        }
        $('fps-meter').hidden = !setting('set-showfps') || !state.started;
    }

    // Build the two engine config files from the player's settings. Classic Doom
    // options live in default.cfg; Crispy Doom's own options in extra.cfg.
    // Settings come from form fields that may hold edited or stale values: always hand the engine a number in range.
    function clamp(value, min, max, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 100) / 100)) : fallback;
    }

    function engineConfigs() {
        const preset = PRESETS[setting('set-graphics')] || PRESETS.ultra;
        const fps = Number(setting('set-fps'));
        const pad = setting('controller-enabled') ? 1 : 0;
        const zone = Math.round(clamp(setting('controller-deadzone'), 0.05, 0.9, 0.25) * 100);
        const vanilla = {
            mouse_sensitivity: clamp(setting('set-sens'), 1, 20, 5), sfx_volume: clamp(setting('set-volume'), 0, 15, 10),
            music_volume: setting('set-music') ? clamp(setting('set-musicvol'), 0, 15, 8) : 0, show_messages: 1,
            // Modern layout: WASD, arrows turn, Ctrl/click fire, E use, Alt strafe, Shift run.
            key_right: 77, key_left: 75, key_up: 17, key_down: 31, key_strafeleft: 30, key_straferight: 32,
            key_fire: 29, key_use: 18, key_strafe: 56, key_speed: 42,
            key_jump: 57, key_lookup: 73, key_lookdown: 81, key_lookcenter: 71, mouseb_jump: -1,
            use_mouse: 1, mouseb_fire: 0, mouseb_strafe: -1, mouseb_forward: -1,
            mouse_sensitivity_y: clamp(setting('set-look'), 1, 20, 5),
            // Controller (Crispy's native analog gamepad support): see joystick_physical_button* below.
            use_joystick: pad, joyb_fire: 0, joyb_strafe: -1, joyb_use: 2, joyb_jump: 1, joyb_speed: setting('set-autorun') ? 29 : 3,
            screenblocks: setting('set-hud') === 'classic' ? 10 : 15, detaillevel: 0, // 15: Crispy HUD at the screen edges
            snd_channels: 16, snd_musicdevice: 3, snd_sfxdevice: 3, usegamma: 0, // 3: Sound Blaster = Crispy's built-in OPL synth for music
        };
        const extended = {
            fullscreen: 0, aspect_ratio_correct: 1, integer_scaling: 0, vga_porch_flash: 0, show_endoom: 0,
            grabmouse: 1, novert: 1, mouse_y_invert: setting('set-invert') ? 1 : 0,
            // Sticks: left moves/strafes, right turns/looks (analog). Virtual buttons 0-7 map to
            // RT, A, X, L3, LB, RB, Start, View (SDL button ids; 22 is the right trigger).
            use_gamepad: pad, use_analog: 1, joystick_index: 0,
            joystick_x_axis: 2, joystick_y_axis: 1, joystick_strafe_axis: 0, joystick_look_axis: 3,
            joystick_x_dead_zone: zone, joystick_y_dead_zone: zone, joystick_strafe_dead_zone: zone, joystick_look_dead_zone: zone,
            joystick_turn_sensitivity: 12, joystick_move_sensitivity: 10, joystick_look_sensitivity: 12,
            joyb_prevweapon: 4, joyb_nextweapon: 5, joyb_menu_activate: 6, joyb_toggle_automap: 7,
            joystick_physical_button0: 22, joystick_physical_button1: 0, joystick_physical_button2: 2,
            joystick_physical_button3: 7, joystick_physical_button4: 9, joystick_physical_button5: 10,
            joystick_physical_button6: 6, joystick_physical_button7: 4, joystick_physical_button8: 1, // 8: B (menu back)
            mouseb_use: 1, mouseb_prevweapon: 4, mouseb_nextweapon: 3,
            crispy_uncapped: fps === 35 ? 0 : 1, crispy_fpslimit: fps === 35 ? 0 : fps, crispy_vsync: 1,
            crispy_widescreen: 1, crispy_smoothscaling: 1,
            crispy_mouselook: 1, crispy_freelook: 2, crispy_freeaim: 1, crispy_jump: 1, crispy_pitch: 1, crispy_centerweapon: 1,
            crispy_crosshair: setting('set-crosshair') ? 2 : 0, crispy_crosshairtarget: 1, crispy_crosshairhealth: 1,
            crispy_coloredhud: 3, crispy_bobfactor: 0, crispy_soundfix: 1, crispy_soundfull: 0,
            ...preset,
        };
        const lines = values => Object.entries(values).map(([k, v]) => `${k.padEnd(30)}${v}`).join('\n') + '\n';
        return {'default.cfg': lines(vanilla), 'extra.cfg': lines(extended)};
    }

    // ---------- Downloads ----------

    const totalBytes = DOWNLOADS.reduce((sum, d) => sum + d.bytes, 0);
    let loadedBytes = 0;

    function renderProgress() {
        const done = Math.min(loadedBytes / totalBytes, 1);
        $('load-bar').style.transform = `scaleX(${done})`;
        $('load-pct').textContent = `${Math.floor(done * 100)}%`;
        $('load-text').textContent = done < 1
            ? `Downloading game data · ${(loadedBytes / 1048576).toFixed(1)} of ${(totalBytes / 1048576).toFixed(1)} MB`
            : 'Starting engine…';
    }

    async function fetchBytes(entry) {
        const response = await fetch(`${entry.file}?v=${VERSION}`);
        if (!response.ok) throw new Error(`${entry.file}: HTTP ${response.status}`);
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            chunks.push(value);
            size += value.byteLength;
            loadedBytes += value.byteLength;
            renderProgress();
        }
        let bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        // Some servers or proxies already undo the gzip layer; only decompress real gzip data.
        if (entry.file.endsWith('.gz') && bytes[0] === 0x1f && bytes[1] === 0x8b) {
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
            bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        }
        return bytes;
    }

    const supported = typeof WebAssembly === 'object' && typeof DecompressionStream === 'function';
    const files = supported
        ? Promise.all(DOWNLOADS.map(async entry => [entry, await fetchBytes(entry)]))
        : Promise.reject(new Error('Browser not supported'));
    let resolveReady, rejectReady;
    const engineReady = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    files.catch(error => rejectReady(error));
    engineReady.then(() => {
        $('loader').hidden = true;
        document.body.classList.add('engine-ready');
    }, error => {
        console.error(error);
        $('load-text').textContent = 'Download failed. Check your connection and reload the page.';
        $('loader').classList.add('error');
    });

    // ---------- Audio ----------

    // Browsers keep an AudioContext silent until the player has interacted with the page. The engine
    // creates its context itself (SDL), so track every context made on this page and resume them on
    // the player's first click, key press, touch or controller button, and whenever the tab returns.
    const audioContexts = new Set();
    for (const name of ['AudioContext', 'webkitAudioContext']) {
        const Native = window[name];
        if (!Native) continue;
        window[name] = class extends Native {
            constructor(...args) { super(...args); audioContexts.add(this); resumeAudio(); }
        };
    }
    function resumeAudio() {
        for (const context of audioContexts) {
            if (context.state === 'suspended' || context.state === 'interrupted') context.resume().catch(() => {});
        }
    }
    window.fraglineAudioState = () => Array.from(audioContexts, context => context.state);
    for (const type of ['pointerdown', 'mousedown', 'keydown', 'touchend', 'click']) {
        window.addEventListener(type, resumeAudio, {capture: true, passive: true});
    }
    window.addEventListener('gamepadconnected', resumeAudio);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeAudio(); });

    // ---------- Saved games ----------

    // Single-player saves are written by the engine into /saves. That folder is mounted from the browser's
    // IndexedDB (IDBFS), so saves survive reloads; the engine tells us after each save and we copy it out.
    // Without IndexedDB (some private windows) the saves still work for the current session.
    let savesReady = null, syncing = false, syncAgain = false;
    function mountSaves() {
        savesReady ??= (async () => {
            try {
                const {FS} = Module;
                FS.mkdir('/saves');
                FS.mount(FS.filesystems.IDBFS, {}, '/saves');
                await new Promise((resolve, reject) => FS.syncfs(true, error => (error ? reject(error) : resolve())));
                Module.fraglineSaved = syncSaves;
            } catch (error) {
                console.warn('Saved games will not be kept after reload:', error);
            }
        })();
        return savesReady;
    }
    window.fraglineSavesIdle = () => !syncing && !syncAgain; // exposed for tests
    function syncSaves() {
        if (syncing) { syncAgain = true; return; }
        syncing = true;
        Module.FS.syncfs(false, error => {
            syncing = false;
            if (error) console.warn('Could not store saved game:', error);
            if (syncAgain) { syncAgain = false; syncSaves(); }
        });
    }

    // ---------- Engine ----------

    window.Module = {
        noInitialRun: true,
        canvas: $('canvas'),
        instantiateWasm(imports, receive) {
            files.then(list => WebAssembly.instantiate(list.find(([e]) => e.wasm)[1], imports))
                .then(result => receive(result.instance, result.module))
                .catch(error => rejectReady(error));
            return {};
        },
        preRun: [() => {
            Module.addRunDependency('fragline-data');
            files.then(list => {
                for (const [entry, bytes] of list) if (entry.as) Module.FS.writeFile(`/${entry.as}`, bytes);
                Module.removeRunDependency('fragline-data');
            }, () => {});
        }],
        onRuntimeInitialized: () => resolveReady(),
        // "Quit Game" in the Esc menu ends the engine; without this the page is left on a dead black canvas.
        onExit: () => { if (state.running) fail('Match ended', 'You left the game. Go back to the menu to play again.'); },
        onAbort: () => { if (state.running) fail('The game stopped', 'The engine hit an error. Go back to the menu and start again.'); },
        print: engineMessage,
        printErr: text => { if (debug) console.warn(text); },
        setStatus: () => {},
    };

    window.fraglineConfigs = engineConfigs; // exposed for tests

    function engineArgs(extra) {
        const args = ['-iwad', 'freedm.wad', '-file', 'fragline.wad', '-window', '-nogui',
            '-config', 'default.cfg', '-extraconfig', 'extra.cfg', '-servername', 'Fragline', '-pet', playerName()];
        if (!state.room) args.push('-savedir', '/saves'); // single-player only; the engine disables saving in network games
        if (!setting('set-sound')) args.push('-nosound');
        else if (!setting('set-music')) args.push('-nomusic'); // no music synth at all: saves its CPU time
        return args.concat(extra);
    }

    async function launch(args, token = state.token) {
        if (state.running) return;
        await engineReady;
        if (token !== state.token) return; // the player left the lobby while the engine was still loading
        state.running = true;
        for (const [name, text] of Object.entries(engineConfigs())) Module.FS.writeFile(`/${name}`, text);
        if (args.includes('-savedir')) await mountSaves();
        document.body.classList.add('playing');
        $('canvas').focus({preventScroll: true});
        callMain(args);
    }

    function matchArgs() {
        const args = ['-warp', $('match-map').value];
        if ($('match-mode').value === 'altdeath') args.push('-altdeath');
        else args.push('-deathmatch');
        return args;
    }

    // Text the engine prints as "doom: <id>, <message>".
    function engineMessage(text) {
        if (debug) console.log(text);
        // The engine found a controller at start-up and reads it itself; controller.js then stays out of the way.
        if (text.startsWith('I_InitGamepad: ') && !/No gamepad|Failed/.test(text)) window.fraglineNativePad = true;
        if (!text.startsWith('doom: ')) return;
        const comma = text.indexOf(',');
        const id = parseInt(text.slice(6, comma), 10);
        const detail = text.slice(comma + 1).trim();
        switch (id) {
            case 1: // websocket connect failed; the engine retries
                if (!state.started) setLobbyStatus('Connection failed, retrying…');
                break;
            case 2:
                if (state.started) toast('Reconnected.');
                else setLobbyStatus(state.host ? 'Room is open. Waiting for players to join…' : 'Connected. Waiting for the match to start…');
                break;
            case 3:
                fail('Room is full', 'Every player slot in this room is taken.');
                break;
            case 6:
                toast('Connection dropped. Reconnecting…', 6000);
                break;
            case 7:
            case 9:
                if (state.started) fail('Disconnected', 'The connection to the match was lost. Start a new room to play again.');
                else fail('Could not connect', state.host ? 'The room server did not respond.' : 'Could not reach the host. Check that the host still has the room open.');
                break;
            case 10:
                if (state.room) matchStarted();
                break;
            case 20: // score screen: the game waits for Fire or Use
                toast('Press Fire or Use to continue.', 6000);
                break;
            case 12: {
                const name = /client '(.*)'/.exec(detail)?.[1] || 'A player';
                toast(`${name} left the match.`);
                break;
            }
        }
    }

    function enterMatch() {
        state.started = true;
        document.body.classList.add('in-match');
        $('panel').hidden = true;
        $('canvas').focus({preventScroll: true});
        renderSettingValues();
        if (!document.pointerLockElement && !padConnected()) $('click-play').hidden = false;
        toast('Esc opens the game menu.', 4000);
    }

    // ---------- Mouse capture ----------

    // Without pointer lock the engine follows the visible cursor, so turning and looking stop at the
    // screen edge. Capture the mouse on the player's click; must run inside a click handler.
    function capturePointer() {
        const canvas = $('canvas');
        if (document.pointerLockElement === canvas) return;
        // Raw mouse input (no OS acceleration) where supported. Chrome on Linux rejects it, and a
        // rejected request uses up the click, so ask for plain pointer lock there.
        const raw = !/Linux/i.test(navigator.platform || '') || /Android/i.test(navigator.userAgent);
        try {
            canvas.requestPointerLock(raw ? {unadjustedMovement: true} : undefined)?.catch?.(() => {});
        } catch { /* not available; the click-to-play layer offers another try */ }
    }

    function padConnected() {
        try { return Array.from(navigator.getGamepads?.() || []).some(p => p?.connected && p.mapping === 'standard'); }
        catch { return false; }
    }

    function matchStarted() {
        stopPolling();
        enterMatch();
        if (state.room && state.host) {
            fetch(`${relay}/api/room/${state.room}/start`, {headers: {'X-Fragline': '1'}, cache: 'no-store'}).catch(() => {});
        }
    }

    function confirmLeave(event) {
        event.preventDefault();
        event.returnValue = '';
    }

    // ---------- Full screen ----------

    // Must run inside a click handler: browsers only allow full screen and
    // keyboard lock in response to the player's own input.
    function enterImmersive() {
        if (!setting('set-fullscreen') || document.fullscreenElement) return;
        const root = document.documentElement;
        root.requestFullscreen?.({navigationUI: 'hide'}).then(() => {
            // Keep Esc for the game menu instead of leaving full screen (Chromium).
            navigator.keyboard?.lock?.(['Escape']).catch(() => {});
        }).catch(() => {});
    }

    function exitImmersive() {
        navigator.keyboard?.unlock?.();
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }

    function toggleFullscreen() {
        if (document.fullscreenElement) exitImmersive();
        else document.documentElement.requestFullscreen?.().catch(() => toast('Full screen is not available here.'));
        $('canvas').focus({preventScroll: true});
    }

    // ---------- Rooms ----------

    async function api(path) {
        const response = await fetch(`${relay}/api/${path}`, {headers: {'X-Fragline': '1'}, cache: 'no-store'});
        const data = await response.json().catch(() => ({}));
        return {ok: response.ok, status: response.status, data};
    }

    function stopPolling() {
        clearInterval(state.poll);
        state.poll = null;
    }

    function pollRoom() {
        stopPolling();
        const update = async () => {
            try {
                const {ok, data} = await api(`room/${state.room}`);
                if (!ok) return;
                $('lobby-count').textContent = `${data.players} of ${data.maxPlayers} players connected`;
            } catch { /* keep the last known count */ }
        };
        update();
        state.poll = setInterval(update, 2000);
    }

    function showLobby(maxPlayers) {
        const link = `${location.origin}/${state.room}`;
        $('lobby-code').textContent = state.room.toUpperCase();
        $('lobby-link').value = link;
        $('lobby-heading').textContent = state.host ? 'Room ready: invite your friends' : 'Joining match';
        $('lobby-share').hidden = !state.host;
        $('lobby-count').textContent = '';
        $('lobby-hint').textContent = state.host
            ? `The match starts automatically when all ${maxPlayers} players have joined. Keep this tab open and visible.`
            : 'The match starts when every player has joined. Keep this tab open and visible.';
        setLobbyStatus(document.body.classList.contains('engine-ready') ? 'Connecting…' : 'Finishing the download…');
        show('lobby');
        window.addEventListener('beforeunload', confirmLeave);
        pollRoom();
    }

    async function createRoom() {
        const button = $('create-room'), token = state.token;
        button.disabled = true;
        enterImmersive();
        try {
            const players = $('match-players').value;
            const {ok, data} = await api(`newroom?players=${players}`);
            if (!ok || !data.room) throw new Error(data.error || 'The room service is unavailable.');
            if (token !== state.token) return;
            state.room = data.room;
            state.host = true;
            showLobby(data.maxPlayers);
            const time = $('match-time').value;
            const args = ['-server', '-privateserver', '-nodes', String(data.maxPlayers), '-dup', '1',
                '-wss', `${wsRelay}/api/ws/${state.room}`].concat(matchArgs());
            if (time !== '0') args.push('-timer', time);
            await launch(engineArgs(args), token);
        } catch (error) {
            fail('Could not create a room', error.message);
        } finally {
            button.disabled = false;
        }
    }

    async function practice() {
        capturePointer();
        enterImmersive();
        $('wait-title').textContent = 'Starting practice…';
        show('wait');
        const token = state.token;
        await engineReady;
        if (token !== state.token) return;
        enterMatch();
        await launch(engineArgs(matchArgs()), token);
    }

    async function checkRoom(code) {
        $('wait-title').textContent = 'Checking room…';
        show('wait');
        try {
            const {ok, data} = await api(`room/${code}`);
            if (!ok) return fail('Room not found', 'This room does not exist or has expired. Ask the host for a new link.');
            if (data.started) return fail('Match already started', 'This match is already in progress. Ask the host to create a new room.');
            if (data.players >= data.maxPlayers) return fail('Room is full', `All ${data.maxPlayers} player slots are taken.`);
            state.room = code;
            $('join-code').textContent = code.toUpperCase();
            $('join-players').textContent = `${data.players} of ${data.maxPlayers} players connected`;
            $('join-name').value = $('player-name').value;
            show('join');
        } catch {
            fail('Could not reach the room server', 'Check your connection and reload the page.');
        }
    }

    async function joinRoom() {
        enterImmersive();
        $('player-name').value = $('join-name').value;
        state.host = false;
        showLobby();
        const token = state.token;
        await launch(engineArgs(['-connect', '1', '-dup', '1', '-wss', `${wsRelay}/api/ws/${state.room}`]), token);
    }

    function goHome() {
        window.removeEventListener('beforeunload', confirmLeave);
        if (state.running) { location.href = '/'; return; }
        state.token++;
        state.room = null;
        stopPolling();
        exitImmersive();
        history.replaceState(null, '', '/');
        show('home');
    }

    function goToCode() {
        // Accept a pasted invite link as well as the bare code.
        const code = ($('room-code').value.trim().split(/[?#]/)[0].split('/').filter(Boolean).pop() || '').toLowerCase();
        if (!CODE.test(code)) {
            $('room-error').textContent = 'Enter the 8-character room code.';
            return;
        }
        $('room-error').textContent = '';
        history.pushState(null, '', `/${code}`);
        checkRoom(code);
    }

    async function copyLink() {
        const field = $('lobby-link');
        try {
            await navigator.clipboard.writeText(field.value);
        } catch {
            field.select();
            document.execCommand('copy');
        }
        toast('Invite link copied.');
        const button = $('copy-link');
        const label = button.querySelector('span');
        const icon = button.querySelector('use');
        button.classList.add('done');
        label.textContent = 'Copied';
        icon.setAttribute('href', '#i-check');
        setTimeout(() => { button.classList.remove('done'); label.textContent = 'Copy link'; icon.setAttribute('href', '#i-copy'); }, 2000);
    }

    // ---------- Menu polish (UI only) ----------

    const visibleActions = () => Array.from(document.querySelectorAll('#panel button, #panel input, #panel select'))
        .filter(el => el.getClientRects().length && !el.disabled);

    // Turn a <select> into a segmented control. The select stays in the DOM as the
    // source of truth (values, saved settings, tests); the buttons just drive it.
    function segmented(id) {
        const select = $(id);
        const group = document.createElement('div');
        group.className = 'seg';
        group.setAttribute('role', 'radiogroup');
        group.setAttribute('aria-labelledby', select.getAttribute('aria-labelledby'));
        const hint = Array.from(select.options).some(o => o.dataset.hint) ? document.createElement('p') : null;
        if (hint) hint.className = 'seg-hint';
        const buttons = Array.from(select.options).map(option => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'seg-btn';
            button.setAttribute('role', 'radio');
            const main = document.createElement('b');
            main.textContent = option.dataset.label || option.text;
            button.append(main);
            if (option.dataset.sub) {
                const sub = document.createElement('small');
                sub.textContent = option.dataset.sub;
                button.append(sub);
            }
            button.addEventListener('click', () => {
                if (select.value === option.value) return;
                select.value = option.value;
                select.dispatchEvent(new Event('change', {bubbles: true}));
            });
            group.append(button);
            return button;
        });
        const sync = () => buttons.forEach((button, i) => {
            const on = select.selectedIndex === i;
            button.setAttribute('aria-checked', String(on));
            button.tabIndex = on ? 0 : -1;
            if (on && hint) hint.textContent = select.options[i].dataset.hint || '';
        });
        group.addEventListener('keydown', event => {
            const step = {ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1}[event.key];
            if (!step) return;
            event.preventDefault();
            const next = (select.selectedIndex + step + buttons.length) % buttons.length;
            buttons[next].click();
            buttons[next].focus();
        });
        select.addEventListener('change', sync);
        select.classList.add('seg-source');
        select.tabIndex = -1;
        select.setAttribute('aria-hidden', 'true');
        select.before(group);
        if (hint) select.before(hint);
        // The controller d-pad focuses every visible select: hop over this hidden one.
        select.addEventListener('focus', event => {
            const list = visibleActions();
            const at = list.indexOf(select), from = list.indexOf(event.relatedTarget);
            const target = from === -1 ? buttons[select.selectedIndex] : list[from < at ? at + 1 : at - 1] || buttons[select.selectedIndex];
            target.focus();
        });
        sync();
    }

    function settingsTabs() {
        const tabs = Array.from(document.querySelectorAll('#screen-settings [role=tab]'));
        const open = tab => tabs.forEach(t => {
            const on = t === tab;
            t.setAttribute('aria-selected', String(on));
            t.tabIndex = on ? 0 : -1;
            $(t.getAttribute('aria-controls')).hidden = !on;
        });
        tabs.forEach((tab, i) => {
            tab.addEventListener('click', () => open(tab));
            tab.addEventListener('keydown', event => {
                const step = {ArrowRight: 1, ArrowLeft: -1}[event.key];
                if (!step) return;
                event.preventDefault();
                const next = tabs[(i + step + tabs.length) % tabs.length];
                open(next);
                next.focus();
            });
        });
    }

    // Player slots mirror the "N of M players connected" text.
    function lobbySlots() {
        const count = $('lobby-count'), list = $('lobby-slots');
        const render = () => {
            const m = /(\d+) of (\d+)/.exec(count.textContent);
            list.hidden = !m;
            if (!m) { list.replaceChildren(); return; }
            const have = Number(m[1]), max = Number(m[2]);
            if (list.children.length !== max) {
                list.replaceChildren(...Array.from({length: max}, (_, i) => {
                    const li = document.createElement('li');
                    li.className = 'slot';
                    li.innerHTML = '<span class="slot-ico"></span><span><b></b><span></span></span>';
                    li.querySelector('.slot-ico').textContent = String(i + 1);
                    li.querySelector('b').textContent = i === 0 ? 'Host' : `Player ${i + 1}`;
                    return li;
                }));
            }
            Array.from(list.children).forEach((li, i) => {
                li.classList.toggle('filled', i < have);
                li.querySelector('span:last-child span').textContent = i < have ? 'Connected' : 'Waiting…';
            });
        };
        new MutationObserver(render).observe(count, {childList: true, characterData: true, subtree: true});
        render();
    }

    function avatar() {
        const field = $('player-name'), badge = $('avatar');
        const update = () => { badge.textContent = (field.value.trim()[0] || '?').toUpperCase(); };
        field.addEventListener('input', update);
        $('random-name').addEventListener('click', update);
        update();
    }

    // Slow pointer parallax on the menu backdrop; skipped for touch and reduced motion.
    function parallax() {
        if (matchMedia('(prefers-reduced-motion: reduce), (hover: none)').matches) return;
        const art = document.querySelector('#panel .bg-art');
        let frame = 0, x = 0, y = 0;
        addEventListener('pointermove', event => {
            x = event.clientX / innerWidth - 0.5;
            y = event.clientY / innerHeight - 0.5;
            if (frame || $('panel').hidden) return;
            frame = requestAnimationFrame(() => {
                frame = 0;
                art.style.setProperty('--px', x.toFixed(3));
                art.style.setProperty('--py', y.toFixed(3));
            });
        }, {passive: true});
    }

    // ---------- Page extras ----------

    function fpsMeter() {
        const el = $('fps-meter');
        let frames = 0, last = performance.now();
        const tick = now => {
            frames++;
            if (now - last >= 500) {
                el.textContent = `${Math.round(frames * 1000 / (now - last))} FPS`;
                frames = 0;
                last = now;
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    async function touchControls() {
        if (!matchMedia('(pointer: coarse)').matches) return;
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = `vendor/nipplejs.js?v=${VERSION}`;
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
        document.body.classList.add('touch');
        const key = (code, down) => {
            const event = new Event(down ? 'keydown' : 'keyup', {bubbles: true, cancelable: true});
            Object.assign(event, {keyCode: code, which: code});
            $('canvas').dispatchEvent(event);
        };
        const held = new Map();
        const set = (code, down) => { if (!!held.get(code) !== down) { held.set(code, down); key(code, down); } };
        const W = 87, S = 83, A = 65, D = 68, TURN_LEFT = 37, TURN_RIGHT = 39, FIRE = 17, USE = 69, JUMP = 32;
        const move = nipplejs.create({zone: $('stick-left'), mode: 'static', position: {left: '50%', top: '50%'}, color: '#ff7a2f'});
        const aim = nipplejs.create({zone: $('stick-right'), mode: 'static', position: {left: '50%', top: '50%'}, color: '#ff7a2f'});
        move.on('move', (_, data) => {
            const active = data.distance > 18, angle = data.angle.radian;
            const x = Math.cos(angle), y = Math.sin(angle);
            set(W, active && y > 0.38); set(S, active && y < -0.38);
            set(A, active && x < -0.38); set(D, active && x > 0.38);
        }).on('end', () => [W, S, A, D].forEach(code => set(code, false)));
        aim.on('start', () => set(FIRE, true))
            .on('move', (_, data) => {
                const far = data.distance > 18;
                set(TURN_LEFT, far && data.direction?.x === 'left');
                set(TURN_RIGHT, far && data.direction?.x === 'right');
                set(USE, far && data.direction?.y === 'up');
                set(JUMP, far && data.direction?.y === 'down');
            })
            .on('end', () => [FIRE, TURN_LEFT, TURN_RIGHT, USE, JUMP].forEach(code => set(code, false)));
    }

    function registerServiceWorker() {
        if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
        navigator.serviceWorker.register(`sw.js?v=${VERSION}`).catch(error => console.warn('Offline cache unavailable:', error));
    }

    function installPrompt() {
        let deferred = null;
        window.addEventListener('beforeinstallprompt', event => {
            event.preventDefault();
            deferred = event;
            $('install-app').hidden = false;
        });
        $('install-app').addEventListener('click', async () => {
            if (!deferred) return;
            deferred.prompt();
            await deferred.userChoice.catch(() => {});
            deferred = null;
            $('install-app').hidden = true;
        });
    }

    function start() {
        bindSettings();
        for (const id of ['match-players', 'match-time', 'match-mode', 'set-graphics', 'set-fps', 'set-hud', 'controller-deadzone']) segmented(id);
        settingsTabs();
        lobbySlots();
        avatar();
        parallax();
        renderProgress();
        $('new-match').addEventListener('click', () => show('create'));
        $('open-settings').addEventListener('click', () => show('settings'));
        $('open-help').addEventListener('click', () => show('help'));
        $('create-room').addEventListener('click', createRoom);
        $('practice').addEventListener('click', practice);
        $('room-code').addEventListener('input', () => { $('room-error').textContent = ''; });
        $('join-form').addEventListener('submit', event => { event.preventDefault(); goToCode(); });
        $('join-room').addEventListener('click', joinRoom);
        $('copy-link').addEventListener('click', copyLink);
        $('lobby-link').addEventListener('focus', e => e.target.select());
        if (navigator.share) {
            $('share-link').hidden = false;
            $('share-link').addEventListener('click', () => navigator.share({title: 'Join my Fragline match', url: $('lobby-link').value}).catch(() => {}));
        }
        for (const button of document.querySelectorAll('[data-home]')) {
            button.addEventListener('click', goHome);
        }
        $('fullscreen').addEventListener('click', toggleFullscreen);
        $('canvas').addEventListener('click', () => { $('canvas').focus({preventScroll: true}); if (state.started) capturePointer(); });
        $('click-play-btn').addEventListener('click', () => { $('click-play').hidden = true; capturePointer(); $('canvas').focus({preventScroll: true}); });
        let escAt = 0;
        document.addEventListener('keydown', event => { if (event.key === 'Escape') escAt = performance.now(); }, true);
        document.addEventListener('pointerlockchange', () => {
            if (document.pointerLockElement) $('click-play').hidden = true;
            else if (state.started && $('panel').hidden && $('click-play').hidden && performance.now() - escAt > 400) toast('Click the game to capture the mouse again.', 3000);
        });
        window.addEventListener('popstate', () => { if (!state.running) location.reload(); });
        window.addEventListener('error', event => console.error(event.error || event.message));
        installPrompt();
        fpsMeter();

        if (!supported) {
            fail('Browser not supported', 'Fragline needs a current version of Chrome, Edge, Firefox or Safari.');
            return;
        }
        const code = location.pathname.slice(1).toLowerCase();
        if (CODE.test(code)) checkRoom(code);
        else show('home');
        touchControls().catch(() => {});
        registerServiceWorker();
    }

    start();
})();
