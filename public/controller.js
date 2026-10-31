/* Standard-mapped browser gamepads; translates to the existing engine controls. */
(() => {
    const pressed = (pad, n) => !!pad.buttons[n]?.pressed || (pad.buttons[n]?.value || 0) > 0.5;
    function gameKeys(pad, deadzone = 0.25) {
        const keys = new Set();
        const x = pad.axes[0] || 0, y = pad.axes[1] || 0;
        if (y < -deadzone || pressed(pad, 12)) keys.add(87); // W
        if (y > deadzone || pressed(pad, 13)) keys.add(83); // S
        if (x < -deadzone) keys.add(65); // A strafe
        if (x > deadzone) keys.add(68); // D strafe
        if (pressed(pad, 14)) keys.add(37); // D-pad turn left
        if (pressed(pad, 15)) keys.add(39); // D-pad turn right
        if (pressed(pad, 7)) keys.add(17); // RT fire
        if (pressed(pad, 6) || pressed(pad, 10)) keys.add(16); // LT / L3 run
        if (pressed(pad, 2)) keys.add(69); // X use
        if (pressed(pad, 0)) { keys.add(32); keys.add(13); } // A jump / confirm
        if (pressed(pad, 1) || pressed(pad, 9)) keys.add(27); // B/Start menu
        if (pressed(pad, 3)) keys.add(9); // Y map
        return keys;
    }
    // Right stick -> mouse counts per second. Radial deadzone, then a squared curve so small
    // deflections give fine aim and full deflection turns quickly.
    const LOOK_COUNTS = 2600;
    function lookDelta(pad, deadzone = 0.25, seconds = 1 / 60) {
        const x = pad.axes[2] || 0, y = pad.axes[3] || 0, m = Math.hypot(x, y);
        if (m <= deadzone) return [0, 0];
        const k = Math.pow(Math.min(1, (m - deadzone) / (1 - deadzone)), 2) / m * LOOK_COUNTS * seconds;
        return [x * k, y * k * 0.7];
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {gameKeys, lookDelta};
        return;
    }
    const status = document.getElementById('controller-status');
    const toggle = document.getElementById('controller-enabled');
    const deadzone = document.getElementById('controller-deadzone');
    const canvas = document.getElementById('canvas');
    let held = new Set(), previous = new Set(), frame = null, slot = 2, last = 0, carryX = 0, carryY = 0;
    const codes = {9:'Tab',13:'Enter',16:'ShiftLeft',17:'ControlLeft',27:'Escape',32:'Space',33:'PageUp',34:'PageDown',37:'ArrowLeft',39:'ArrowRight',65:'KeyA',68:'KeyD',69:'KeyE',83:'KeyS',87:'KeyW'};
    function emit(number, down) {
        const event = new Event(down ? 'keydown' : 'keyup', {bubbles:true, cancelable:true});
        Object.assign(event, {keyCode:number, which:number, code:codes[number] || `Digit${number - 48}`});
        canvas.dispatchEvent(event);
    }
    function release() {
        held.forEach(key => emit(key, false));
        held.clear();
        previous.clear();
    }
    function report(text) { if (status.textContent !== text) status.textContent = text; }
    // The engine reads mouse motion as whole counts; keep the fractions so slow stick movement still turns.
    function look(pad, seconds) {
        const [dx, dy] = lookDelta(pad, Number(deadzone.value), seconds);
        carryX += dx; carryY += dy;
        const mx = Math.trunc(carryX), my = Math.trunc(carryY);
        if (!mx && !my) return;
        carryX -= mx; carryY -= my;
        canvas.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, movementX: mx, movementY: my, clientX: 0, clientY: 0}));
    }
    function rumble(pad, strong, weak, ms) {
        pad.vibrationActuator?.playEffect?.('dual-rumble', {duration: ms, strongMagnitude: strong, weakMagnitude: weak}).catch(() => {});
    }
    const isNew = (buttons, n) => buttons.has(n) && !previous.has(n);
    function menuActions() {
        // One stop per option group: skip unselected segmented choices and settings tabs.
        return Array.from(document.querySelectorAll('#panel button, #panel input, #panel select, #panel a[href], #click-play:not([hidden]) button'))
            .filter(el => el.getClientRects().length && !el.disabled && !el.classList.contains('seg-source')
                && !(el.matches('.seg-btn') && el.getAttribute('aria-checked') !== 'true')
                && !(el.matches('[role=tab]') && el.getAttribute('aria-selected') !== 'true'));
    }
    function menuStep(buttons) {
        const actions = menuActions();
        const active = document.activeElement;
        const direction = isNew(buttons, 13) ? 1 : isNew(buttons, 12) ? -1 : 0;
        if (direction && actions.length) {
            const index = actions.indexOf(active);
            actions[(index + direction + actions.length) % actions.length].focus();
        }
        const side = isNew(buttons, 15) ? 1 : isNew(buttons, 14) ? -1 : 0;
        if (side && active) {
            const group = active.closest('.seg, .tabs');
            const items = group ? Array.from(group.querySelectorAll('button')) : [];
            if (items.length) {
                const next = items[(items.indexOf(active) + side + items.length) % items.length];
                next.click(); next.focus();
            } else if (active.tagName === 'SELECT') {
                const index = Math.max(0, Math.min(active.options.length - 1, active.selectedIndex + side));
                if (index !== active.selectedIndex) { active.selectedIndex = index; active.dispatchEvent(new Event('change', {bubbles: true})); }
            } else if (active.type === 'range') {
                active.value = String(Number(active.value) + side * (Number(active.step) || 1));
                active.dispatchEvent(new Event('input', {bubbles: true}));
            }
        }
        if (isNew(buttons, 0)) {
            const target = actions.includes(active) ? active : actions.find(el => el.tagName !== 'INPUT');
            if (target?.type === 'text') target.focus(); else target?.click();
        }
        if (isNew(buttons, 1)) {
            // B: back out of the current screen (also leaves a lobby or dismisses an error).
            const back = document.querySelector('#panel .screen:not([hidden]) [data-home]');
            if (back && back.getClientRects().length) back.click();
        }
    }
    function tick(now) {
        frame = null;
        const seconds = Math.min(0.05, (now - last) / 1000 || 1 / 60);
        last = now;
        let pads;
        try { pads = Array.from(navigator.getGamepads()); }
        catch { report('Controller access is unavailable in this browser.'); release(); return; }
        const pad = pads.find(p => p?.connected && p.mapping === 'standard');
        if (!pad) {
            report(pads.some(Boolean) ? 'This controller has no standard layout. Use keyboard or another controller.' : 'Connect a controller and press a button.');
            release();
            return;
        }
        report(`Controller connected: ${pad.id}`);
        if (!toggle.checked || document.hidden || !document.hasFocus()) {
            release();
        } else {
            const buttons = new Set(pad.buttons.map((_, i) => pressed(pad, i) ? i : -1).filter(i => i >= 0));
            const inGame = document.body.classList.contains('playing') && document.getElementById('panel').hidden;
            if (inGame && window.fraglineNativePad) {
                // The engine reads the controller itself (analog sticks); only add rumble here.
                if (held.size) { held.forEach(key => emit(key, false)); held.clear(); }
                if (buttons.has(7) && !previous.has(7)) rumble(pad, 0.5, 0.4, 70);
            } else if (inGame) {
                const keys = gameKeys(pad, Number(deadzone.value));
                for (const key of held) if (!keys.has(key)) emit(key, false);
                for (const key of keys) if (!held.has(key)) emit(key, true);
                held = keys;
                // Synthetic mouse motion only reaches the engine while the mouse is captured.
                if (document.pointerLockElement) look(pad, seconds);
                if (buttons.has(7) && !previous.has(7)) rumble(pad, 0.5, 0.4, 70);
                // Change weapons once per shoulder-button press.
                for (const [button, step] of [[4, -1], [5, 1]]) {
                    if (buttons.has(button) && !previous.has(button)) {
                        slot = Math.max(1, Math.min(7, slot + step));
                        emit(48 + slot, true); emit(48 + slot, false);
                    }
                }
            } else {
                // Menus: d-pad up/down moves, left/right changes the focused option, A selects, B goes back.
                menuStep(buttons);
            }
            previous = buttons;
        }
        frame = requestAnimationFrame(tick);
    }
    function start() { if (frame === null) frame = requestAnimationFrame(tick); }
    toggle.addEventListener('change', () => { release(); start(); });
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', release);
    window.addEventListener('gamepadconnected', start);
    window.addEventListener('gamepaddisconnected', () => { release(); start(); });
    if (!window.isSecureContext) {
        toggle.checked = false;
        toggle.disabled = true;
        report('Controllers need HTTPS or localhost. Local HTTP still supports keyboard/mouse. See PI-SETUP.md for local HTTPS.');
    } else if (!navigator.getGamepads) {
        toggle.disabled = true;
        report('This browser does not support controllers.');
    } else start();
})();
