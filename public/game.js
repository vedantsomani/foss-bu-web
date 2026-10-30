/* Fragline browser client: downloads, lobby, room flow and engine start-up. */
'use strict';
(() => {
    const VERSION = '1.0.0';
    // Sizes are the bytes sent over the wire; tests/static.test.cjs keeps them in sync.
    const DOWNLOADS = [
        {file: 'websockets-doom.wasm.gz', bytes: 2387725, wasm: true},
        {file: 'freedm.wad.gz', bytes: 8513298, as: 'freedm.wad'},
        {file: 'fragline.wad', bytes: 68196, as: 'fragline.wad'},
        {file: 'default.cfg', bytes: 1593, as: 'default.cfg'},
        {file: 'smooth.cfg', bytes: 1593, as: 'smooth.cfg'},
        {file: 'extra.cfg', bytes: 64, as: 'extra.cfg'},
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

    const $ = id => document.getElementById(id);
    const relayMeta = document.querySelector('meta[name="fragline-relay"]')?.content.trim();
    const relay = (relayMeta || location.origin).replace(/\/$/, '');
    const wsRelay = relay.replace(/^http/, 'ws');
    const store = {
        get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
        set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
    };

    const state = {room: null, host: false, started: false, running: false, poll: null};

    // ---------- Screens and messages ----------

    function show(screen) {
        for (const el of document.querySelectorAll('#panel > .screen')) el.hidden = el.id !== `screen-${screen}`;
        $('panel').hidden = false;
        const focusable = $(`screen-${screen}`).querySelector('[autofocus], input, select, button');
        focusable?.focus({preventScroll: true});
    }

    function fail(title, detail) {
        stopPolling();
        $('message-title').textContent = title;
        $('message-text').textContent = detail || '';
        show('message');
        window.removeEventListener('beforeunload', confirmLeave);
    }

    let toastTimer = null;
    function toast(text, ms = 4000) {
        const el = $('toast');
        el.textContent = text;
        el.hidden = false;
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

    function bindSettings() {
        $('player-name').value = cleanName(store.get('fragline-name', '')) || randomName();
        for (const id of ['player-name', 'join-name']) $(id).addEventListener('input', e => { e.target.value = cleanName(e.target.value); });
        $('random-name').addEventListener('click', () => { $('player-name').value = randomName(); });
        for (const id of ['smooth-play', 'mute-game']) {
            const box = $(id);
            box.checked = store.get(`fragline-${id}`, '0') === '1';
            box.addEventListener('change', () => store.set(`fragline-${id}`, box.checked ? '1' : '0'));
        }
        const map = $('match-map');
        MAPS.forEach((name, i) => map.add(new Option(`${String(i + 1).padStart(2, '0')} · ${name}`, String(i + 1))));
        for (const id of ['match-map', 'match-players', 'match-time', 'match-mode']) {
            const field = $(id);
            field.value = store.get(`fragline-${id}`, field.value);
            if (field.selectedIndex < 0) field.selectedIndex = 0;
            field.addEventListener('change', () => store.set(`fragline-${id}`, field.value));
        }
    }

    // ---------- Downloads ----------

    const totalBytes = DOWNLOADS.reduce((sum, d) => sum + d.bytes, 0);
    let loadedBytes = 0;

    function renderProgress() {
        const done = Math.min(loadedBytes / totalBytes, 1);
        $('load-bar').style.transform = `scaleX(${done})`;
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
        print: engineMessage,
        printErr: text => console.warn(text),
        setStatus: () => {},
    };

    function engineArgs(extra) {
        const args = ['-iwad', 'freedm.wad', '-file', 'fragline.wad', '-window', '-nogui', '-nomusic',
            '-config', $('smooth-play').checked ? 'smooth.cfg' : 'default.cfg', '-extraconfig', 'extra.cfg',
            '-servername', 'Fragline', '-pet', playerName()];
        if ($('mute-game').checked) args.push('-nosound');
        return args.concat(extra);
    }

    async function launch(args) {
        if (state.running) return;
        await engineReady;
        state.running = true;
        document.body.classList.add('playing');
        $('settings').disabled = true;
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
    const debug = new URLSearchParams(location.search).has('debug');
    function engineMessage(text) {
        if (debug) console.log(text);
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
                matchStarted();
                break;
            case 12: {
                const name = /client '(.*)'/.exec(detail)?.[1] || 'A player';
                toast(`${name} left the match.`);
                break;
            }
        }
    }

    function matchStarted() {
        state.started = true;
        stopPolling();
        document.body.classList.add('in-match');
        $('panel').hidden = true;
        $('canvas').focus({preventScroll: true});
        toast('Click the game to capture the mouse. Esc releases it.', 6000);
        if (state.room && state.host) {
            fetch(`${relay}/api/room/${state.room}/start`, {headers: {'X-Fragline': '1'}, cache: 'no-store'}).catch(() => {});
        }
    }

    function confirmLeave(event) {
        event.preventDefault();
        event.returnValue = '';
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
        const button = $('create-room');
        button.disabled = true;
        try {
            const players = $('match-players').value;
            const {ok, data} = await api(`newroom?players=${players}`);
            if (!ok || !data.room) throw new Error(data.error || 'The room service is unavailable.');
            state.room = data.room;
            state.host = true;
            showLobby(data.maxPlayers);
            const time = $('match-time').value;
            const args = ['-server', '-privateserver', '-nodes', String(data.maxPlayers), '-dup', '1',
                '-wss', `${wsRelay}/api/ws/${state.room}`].concat(matchArgs());
            if (time !== '0') args.push('-timer', time);
            await launch(engineArgs(args));
        } catch (error) {
            fail('Could not create a room', error.message);
        } finally {
            button.disabled = false;
        }
    }

    async function practice() {
        $('wait-title').textContent = 'Starting practice…';
        show('wait');
        await engineReady;
        $('panel').hidden = true;
        state.started = true;
        document.body.classList.add('in-match');
        await launch(engineArgs(matchArgs()));
        toast('Click the game to capture the mouse. Esc releases it.', 6000);
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
        $('player-name').value = $('join-name').value;
        state.host = false;
        showLobby();
        await launch(engineArgs(['-connect', '1', '-dup', '1', '-wss', `${wsRelay}/api/ws/${state.room}`]));
    }

    function goToCode() {
        const code = $('room-code').value.trim().toLowerCase();
        if (!CODE.test(code)) {
            $('room-error').textContent = 'Enter the 8-character room code.';
            return;
        }
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
    }

    // ---------- Page controls ----------

    function fullscreen() {
        const game = $('game');
        if (document.fullscreenElement) document.exitFullscreen();
        else game.requestFullscreen?.().catch(() => toast('Fullscreen is not available here.'));
        $('canvas').focus({preventScroll: true});
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
        const W = 87, S = 83, A = 65, D = 68, TURN_LEFT = 79, TURN_RIGHT = 80, FIRE = 32, USE = 69, ENTER = 13;
        const move = nipplejs.create({zone: $('stick-left'), mode: 'static', position: {left: '50%', top: '50%'}, color: '#ff7a2f'});
        const aim = nipplejs.create({zone: $('stick-right'), mode: 'static', position: {left: '50%', top: '50%'}, color: '#ff7a2f'});
        move.on('move', (_, data) => {
            const active = data.distance > 18, angle = data.angle.radian;
            const x = Math.cos(angle), y = Math.sin(angle);
            set(W, active && y > 0.38); set(S, active && y < -0.38);
            set(TURN_LEFT, active && x < -0.38); set(TURN_RIGHT, active && x > 0.38);
        }).on('end', () => [W, S, TURN_LEFT, TURN_RIGHT].forEach(code => set(code, false)));
        aim.on('start', () => { set(FIRE, true); set(ENTER, true); })
            .on('move', (_, data) => {
                const strafe = data.distance > 18 ? data.direction?.x : null;
                set(A, strafe === 'left'); set(D, strafe === 'right');
                set(USE, data.distance > 18 && data.direction?.y === 'up');
            })
            .on('end', () => [FIRE, ENTER, A, D, USE].forEach(code => set(code, false)));
    }

    function registerServiceWorker() {
        if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
        navigator.serviceWorker.register(`sw.js?v=${VERSION}`).catch(error => console.warn('Offline cache unavailable:', error));
    }

    function start() {
        bindSettings();
        renderProgress();
        $('new-match').addEventListener('click', () => show('create'));
        $('create-room').addEventListener('click', createRoom);
        $('practice').addEventListener('click', practice);
        $('join-form').addEventListener('submit', event => { event.preventDefault(); goToCode(); });
        $('join-room').addEventListener('click', joinRoom);
        $('copy-link').addEventListener('click', copyLink);
        $('lobby-link').addEventListener('focus', e => e.target.select());
        if (navigator.share) {
            $('share-link').hidden = false;
            $('share-link').addEventListener('click', () => navigator.share({title: 'Join my Fragline match', url: $('lobby-link').value}).catch(() => {}));
        }
        for (const button of document.querySelectorAll('[data-home]')) {
            button.addEventListener('click', () => { if (state.running) location.href = '/'; else { history.replaceState(null, '', '/'); show('home'); } });
        }
        $('fullscreen').addEventListener('click', fullscreen);
        $('canvas').addEventListener('click', () => $('canvas').focus({preventScroll: true}));
        window.addEventListener('popstate', () => { if (!state.running) location.reload(); });
        window.addEventListener('error', event => console.error(event.error || event.message));

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
