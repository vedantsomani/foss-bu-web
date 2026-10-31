# Fragline

Retro deathmatch for 2–4 players that runs in the browser. Create a room, share the 8-character code or link, and play. Nothing to install.

- **Engine:** Chocolate Doom compiled to WebAssembly (the WebSocket networking build from Cloudflare's doom-wasm).
- **Game data:** the free deathmatch set from the Freedoom project, rebranded as Fragline in the game and site. It has 32 maps, all selectable in the lobby. No commercial Doom files are needed.
- **Modes:** Deathmatch and Deathmatch 2.0 (items respawn), with a 5–20 minute or unlimited time limit, plus solo practice on any map.
- **Hosting:** Cloudflare Workers + Durable Objects for online rooms, or `lan_server.py` for fully offline play on a local network (Raspberry Pi or laptop).

Works in current Chrome, Edge, Firefox and Safari on Windows, Linux and macOS. Touch controls on phones are experimental.

## Browser performance

- **About 11 MB on the first visit** (down from about 32 MB). The engine and WAD are shipped gzip-compressed and decompressed in the browser with `DecompressionStream`, because Cloudflare does not compress `.wad` files.
- **Instant repeat visits.** A service worker caches the game files under a version key (on HTTPS or localhost).
- **Real download progress** while the menus stay usable. A room link is checked as soon as the page opens, not after the download.
- **Mouse capture** (pointer lock) on click, and the mouse only turns: vertical mouse movement no longer walks you forward.
- **Optional "Smoother play"** (low detail, fewer sound channels) and "Sound off" settings.

These reduce download, start-up and rendering work. They don't remove network latency: Doom's netcode keeps all players in lockstep, so the slowest connection sets the pace, and every player must keep the tab visible. Local-network play through `lan_server.py` feels best.

## Engine limits

Up to 4 players (the Chocolate Doom maximum). No vertical aiming. Classic Doom movement. The match starts automatically once the chosen number of players has joined. Zandronum or Odamex clients can't join; this is a separate browser engine.

## Run it

Online relay (Cloudflare):

```bash
npm install
```

```bash
npm start
```

That serves the Worker locally at http://127.0.0.1:8765. To publish by hand: `npx wrangler login`, then `npm run deploy`. The Worker is named `foss-bu-web` and publishes to `foss-bu-web.vedantsomani12.workers.dev`. For automatic deploys, connect the `foss-bu-web` Worker to this GitHub repository in the Cloudflare dashboard (Workers Builds); the Worker name there must match `name` in `wrangler.json`. Update `account_id` in `wrangler.json` and the `og:image` URL in `public/index.html` for another account or domain.

Local network, no Internet needed: see [PI-SETUP.md](PI-SETUP.md), or run:

```bash
python3 lan_server.py
```

## Tests

```bash
npm test
```

That runs the static checks, the controller mapping test, the Python file-serving tests, the relay protocol tests and a headless browser test where a host and a guest play a real match. The browser test needs Playwright with Chromium. To run the relay and browser tests against the Cloudflare Worker, start it with `npm start` and pass its URL:

```bash
node tests/relay.test.cjs http://127.0.0.1:8765
```

```bash
node tests/browser.test.cjs http://127.0.0.1:8765 4
```

## Changing the art or version

`python3 tools/make_art.py` regenerates the Fragline-branded game graphics (`public/fragline.wad`: title, menu logo, credit and help screens, quit screen and text strings), `public/share.png` and `public/backdrop.jpg`. When you change any game file, bump `VERSION` in `public/game.js` and every `?v=` in the HTML pages (`npm test` checks they match). That way browsers and the offline cache pick up the new files.

## Credits

FreeDM by the Freedoom contributors (BSD-style license). Chocolate Doom WebAssembly (GPL-2.0); see `ENGINE-SOURCE-AND-CREDITS.txt` for binary provenance, corresponding source and the one change made to the loader. The relay design follows Cloudflare's multiplayer Doom (BSD 3-clause, `CLOUDFLARE-LICENSE.txt`). Touch joysticks use nipplejs (MIT).
