# FOSS-BU Arena — browser edition

Browser-first FreeDM arena with two-player online rooms, hosted together on Cloudflare Workers and Durable Objects. Open the website on Windows, Linux/Arch/CachyOS, or macOS using a modern desktop browser. Share the invite link or eight-character room code, choose names, and keep both tabs open. The host selects Next; the match starts when both players connect.

No inbound firewall rule, LAN IP, game install, or port forwarding is needed. Networks that block WebSockets can still prevent play. First download is approximately 33 MB. Desktop Zandronum/Odamex clients cannot join these rooms. Browser zombie/co-op and ten-player modes are not implemented. Mobile controls are experimental.

## Development and deployment

Install Node.js, run `npm install`, then `npm start`. For Cloudflare, use `npx wrangler login` and `npm run deploy`. Change `account_id` in wrangler.json for another account. No credentials belong in Git. Deployment is currently manual; GitHub push alone does not redeploy the Worker.

## Credits

FreeDM 0.13.0: Freedoom contributors, BSD-style license and credits in public/FreeDM-*.txt. Custom FOSS-BU map/title artwork overlays those assets. Browser frontend/room router adapted from Cloudflare doom, MIT (CLOUDFLARE-LICENSE.txt). Engine is Chocolate Doom WebAssembly, GPL-2.0 (ENGINE-LICENSE.txt); see ENGINE-SOURCE-AND-CREDITS.txt for the binary source provenance. Preserve each component's license. No commercial Doom WAD is required.

Rooms expire after 12 hours. This is a testing release, not a guarantee of cross-platform performance or large-scale multiplayer reliability.

## Performance update

The optional Smoother play setting uses Doom low detail and four simultaneous audio channels. Uncheck it before starting for original detail. Sound off is optional. Decorative monitor/footer animations are disabled. These reduce rendering/audio work; they do not eliminate Internet latency or change the engine tick rate. All players need to keep their game tabs visible. No change was made to network tick duplication.

## Local server and controllers

Start with **PI-SETUP.md** for Raspberry Pi and local HTTPS. **Start Wi-Fi Game.cmd** hosts the same browser game on Windows. **CODEX-NEXT-STEPS.md** is the continuation prompt. The optional standard controller mapping is in public/controller.js. Physical controllers and Pi hardware still need testing. Controller access requires trusted HTTPS or localhost; LAN HTTP remains keyboard/mouse only.
