# Fragline next-gen engine (beta)

A from-scratch browser engine for Fragline that plays the FreeDM maps. Try it at `/lab/play/`.
The main game at `/` still runs on Crispy Doom (see `engine/`); this engine replaces it once it
has been played on real hardware.

## Why a new engine

Crispy Doom keeps Doom's lockstep netcode: every player waits for the slowest one, and a hidden
tab freezes the match. This engine uses the approach modern shooters use instead:

- **Host-authoritative simulation at 60 Hz** (`game/sim.js`), deterministic and seeded.
- **Client prediction and reconciliation** for your own movement, **snapshot interpolation**
  (~100 ms) for other players, and **lag compensation** for hitscan (`net/`). A slow or lost
  player never stalls the others.
- **WebGL2 renderer** (`render/`): BSP front-to-back culling with a column occluder, sector
  lighting with Doom's light falloff, dynamic lights that respect closed doors, bloom, and doors
  and lifts animated in the vertex shader. The pixel-art look is kept.
- **Feel** (`play/`): pointer lock with raw input where the browser allows it, and a camera that
  applies mouse movement every display frame, not just every simulation tick. It also has
  keyboard lock for Esc, an uncapped `requestAnimationFrame` loop with interpolation, dynamic
  resolution to hold the frame rate, no per-frame allocations in the hot path, and an
  interactive-latency WebAudio mixer with positional sound.

## Layout

| Folder | What |
|---|---|
| `wad.js` | WAD and map loader shared by everything |
| `render/` | WebGL2 renderer, plus a fly-through demo (`render/index.html`, `?bench=1`) |
| `game/` | Simulation, weapons, items, doors/lifts/teleporters, first-person weapon view |
| `net/` | Transports (relay WebSocket, in-memory test network), host and client |
| `play/` | The game: menus, input, HUD, audio, bots, rooms, settings |
| `tests/` | `node --test public/lab/tests/` (60 tests: determinism, collision, weapons, doors, prediction under latency and loss, lag compensation, real relay) |

## Status

These run in headless Chromium: practice with bots, 2-player rooms over the real relay, and doors,
lifts, switches and teleporters. Software rendering in the test machine reaches only 2–21 FPS,
so smoothness on a real GPU at 120/144 Hz, mouse feel and audio still need testing on a laptop.

Not done yet: player name tags, bots using doors, switch texture swaps, keys, exits, scrolling
walls, crushers, and a 3D viewmodel (weapons are FreeDM sprites with modern sway, bob and
recoil).

## Next steps

1. Play-test on real laptops (Windows and Linux, 60 and 144 Hz) and tune feel: sensitivity
   curves, view bob, weapon timing.
2. Measure input-to-photon latency and frame pacing; move rendering to an OffscreenCanvas worker
   if the main thread causes hitches.
3. Run the host simulation on the relay server (a Durable Object) instead of a player's browser,
   so the host's connection no longer matters.
4. When it is at least as good as the Crispy Doom build, make it the main game.
