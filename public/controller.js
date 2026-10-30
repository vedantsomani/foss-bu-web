/* Standard-mapped browser gamepads; translates to the existing engine controls. */
(() => {
    const pressed = (pad, n) => !!pad.buttons[n]?.pressed || (pad.buttons[n]?.value || 0) > 0.5;
    function gameKeys(pad, deadzone = 0.25) {
        const keys = new Set();
        const x = pad.axes[0] || 0, y = pad.axes[1] || 0, turn = pad.axes[2] || 0, look = pad.axes[3] || 0;
        if (y < -deadzone || pressed(pad, 12)) keys.add(87); // W
        if (y > deadzone || pressed(pad, 13)) keys.add(83); // S
        if (x < -deadzone) keys.add(65); // A strafe
        if (x > deadzone) keys.add(68); // D strafe
        if (turn < -deadzone || pressed(pad, 14)) keys.add(37); // turn left
        if (turn > deadzone || pressed(pad, 15)) keys.add(39); // turn right
        if (look < -deadzone) keys.add(33); // look up
        if (look > deadzone) keys.add(34); // look down
        if (pressed(pad, 7)) keys.add(17); // RT fire
        if (pressed(pad, 6) || pressed(pad, 10)) keys.add(16); // LT / L3 run
        if (pressed(pad, 2)) keys.add(69); // X use
        if (pressed(pad, 0)) { keys.add(32); keys.add(13); } // A jump / confirm
        if (pressed(pad, 1) || pressed(pad, 9)) keys.add(27); // B/Start menu
        if (pressed(pad, 3)) keys.add(9); // Y map
        return keys;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {gameKeys};
        return;
    }
    const status = document.getElementById('controller-status');
    const toggle = document.getElementById('controller-enabled');
    const deadzone = document.getElementById('controller-deadzone');
    const canvas = document.getElementById('canvas');
    let held = new Set(), previous = new Set(), frame = null, slot = 2;
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
    function tick() {
        frame = null;
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
            if (document.body.classList.contains('playing')) {
                const keys = gameKeys(pad, Number(deadzone.value));
                for (const key of held) if (!keys.has(key)) emit(key, false);
                for (const key of keys) if (!held.has(key)) emit(key, true);
                held = keys;
                // Change weapons once per shoulder-button press.
                for (const [button, step] of [[4, -1], [5, 1]]) {
                    if (buttons.has(button) && !previous.has(button)) {
                        slot = Math.max(1, Math.min(7, slot + step));
                        emit(48 + slot, true); emit(48 + slot, false);
                    }
                }
            } else {
                // Move between lobby actions; keyboard remains available for name/code entry.
                const actions = Array.from(document.querySelectorAll('#panel button, #panel input, #panel select'))
                    .filter(el => el.getClientRects().length && !el.disabled);
                const direction = buttons.has(13) && !previous.has(13) ? 1 : buttons.has(12) && !previous.has(12) ? -1 : 0;
                if (direction && actions.length) {
                    const index = actions.indexOf(document.activeElement);
                    actions[(index + direction + actions.length) % actions.length].focus();
                }
                if (buttons.has(0) && !previous.has(0)) {
                    const active = actions.includes(document.activeElement) ? document.activeElement : actions.find(el => el.tagName !== 'INPUT');
                    active?.click();
                }
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
