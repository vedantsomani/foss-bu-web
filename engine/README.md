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
