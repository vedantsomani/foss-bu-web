# Fragline engine

Crispy Doom 7.2 (GPL-2.0-or-later, see `crispy-doom/COPYING.md` and `UPSTREAM.md`) compiled to
WebAssembly, with Cloudflare doom-wasm's WebSocket networking ported in. Every change is marked
`[fragline]` in the source and is in the git history after the "Import Crispy Doom" commit.

What it adds over the original browser build: frame rate that follows the display (60/120/144 Hz)
with interpolation, 640×400 rendering with widescreen, true-color mode, smooth lighting, brightmaps,
mouselook with networked vertical aim, crosshair, jumping, and a compressed size of about 0.7 MB.

## Build

Needs Emscripten with the SDL2 and SDL2_mixer ports:

```bash
engine/build.sh
```

It writes `public/websockets-doom.js` and `public/websockets-doom.wasm.gz`. Then update the
`websockets-doom.wasm.gz` size in `public/game.js` (`npm test` checks it). `engine/build.sh --debug`
builds faster with debug info.

## Changes

- `src/net_websockets.c`: relay transport (`[to][from][payload]` over one WebSocket).
- `src/d_loop.c`: server/client set-up over the relay; player ids from `crypto.getRandomValues`.
- `src/doom/d_main.c`, `src/i_timer.c`, `src/i_system.c`, `src/i_endoom.c`, `src/i_main.c`: browser
  main loop, sleeps and exit.
- `src/net_client.c`, `src/net_common.c`: `-pet` player name, longer connect wait, 10 s peer timeout.
- `src/net_structrw.c`: mouse-look deltas are sent with each move so aim is the same for everyone.
- `src/crispy.c`, `src/doom/p_user.c`, `src/doom/p_mobj.c`, `src/doom/d_net.c`: in network games,
  direct aiming and jumping are on for everyone and nothing depends on a player's local settings.
- `opl/opl.c`: the software OPL synthesizer (music) is not probed at start-up. The probe waits for
  audio callbacks, which do not run until the player has clicked the page, so it could hang the
  start. Music is Crispy's own OPL emulation playing the IWAD's MUS lumps (`snd_musicdevice 3`).
- `src/net_websockets.c`: bounds checks on incoming WebSocket messages. Text frames, messages
  without a header and payloads over 2048 bytes (a game packet is under 1500) are dropped, and the
  queue is checked before anything is allocated, so a hostile peer cannot exhaust the zone heap.
- `src/crispy.c`, `src/doom/d_main.c`: `CRISPY_ClampConfig()` and a few range checks run right
  after the config files load, so a corrupt or edited value cannot index past the end of a table.
- `src/doom/g_game.c`: after a save is written the engine calls `Module.fraglineSaved()`. The page
  mounts `/saves` from IndexedDB (IDBFS, `-lidbfs.js`) and copies it out then, so single-player
  saves survive reloads.
- `src/doom/m_menu.c`: in the Esc menu a controller's A button selects, B goes back and, at the top
  level, resumes the game (the original only had Fire / Use).
- `src/doom/fl_api.c`: `fl_state(n)` and `fl_command(n, arg)`, read-only numbers (map, health,
  weapon, last tic command, heap use, ...) and two single-player-only test commands (end level,
  die). The browser tests use them; `fl_command` does nothing in a network game.
- `src/doom/wi_stuff.c`: prints `doom: 20, intermission` so the page can say how to leave the score
  screen (Fire or Use, as in Doom).
- `build.sh`: links `-lidbfs.js`.
