# Prompt for Codex

Open THIS folder as the workspace: foss-bu-web. Read README.md, PI-SETUP.md and the existing code first. This is the browser-first FOSS-BU Arena project; the older prayush-game repository holds the separate native Zandronum desktop version.

Improve this existing game into a polished, reliable browser multiplayer release that works the same from Windows, Arch/CachyOS, and other desktop browsers. Preserve the FreeDM/FOSS-BU identity, maps, credits, licenses and working room-code workflow. Improve real playable quality, not just marketing artwork. Do not replace the game with a landing-page mockup.

Current scope: two-player classic Doom WebAssembly game, Cloudflare Worker/Durable Object relay, Python local LAN relay, optional low-detail/mute settings, standard Gamepad API controller input, keyboard/mouse and experimental touch input. The browser engine cannot join Zandronum/Odamex matches. Native ten-player, zombies and co-op are not ported. Do not claim those work by merely changing a player-limit number.

Deployment target: Pi 5 8 GB with a 64 GB card hosts both the website and room relay, connected to the laptops' router by Wi-Fi. Pi 4 2/4 GB connects directly to Pi 5 by Ethernet for backup or a separate instance. Their CPU/RAM is not pooled. Keep active local matches entirely off the Internet. Supply simple startup/service setup, useful connection status, and a tested backup/restore process. Controllers over LAN need trusted HTTPS (see PI-SETUP.md), not plain HTTP at a private IP.

Priorities:
1. Measure multiplayer latency/jitter and stalls; compare solo versus online versus local. Prefer local/direct transport for same-network matches. Keep gameplay responsive without breaking synchronization. Do not invent benchmark results.
2. Test and improve standard Xbox/PlayStation controller compatibility, deadzone, menu navigation, remapping, disconnection/blur key release, keyboard/controller coexistence, and clear prompts. Document classic engine limitations such as no vertical look. Do not promise universal controller support.
3. Improve lobby, loading progress, invitations/copy fallback, accessible keyboard focus, room-full/expired/disconnected feedback, reconnect/rematch flow where the engine permits it, and readable in-game help. Avoid decorative rendering overhead.
4. Audit the older desktop source in ../prayush-game/desktop/launcher.py and payload for desired features. Propose and implement compatible map/mode improvements incrementally. If changing engines is needed for modern rendering, 10 players or zombies, explain the migration and prove a working match before claiming parity. Avoid proprietary assets or unlicensed downloads.
5. Keep browser downloads self-contained for LAN/offline play. Review engine source/build provenance and prefer a reproducible optimized release build rather than editing generated WASM blindly. Preserve upstream licensing and corresponding source requirements.
6. Run meaningful local server/protocol tests, controller input simulations and limited browser checks. Report separately what was actually tested, what needs physical controllers, what needs both laptops and what needs Pi hardware. Do not repeatedly open the game or interrupt the user's applications.

Work autonomously on reversible improvements. Never print secrets or commit credentials. Do not flash storage, overwrite existing Pi data, change network/security settings, publish new deployments, or replace a running match without checking the current authorization and impact. Leave concrete files, clear run instructions and a concise verification report. Do not describe the project as the best game in the world or fully tested unless evidence supports the claim.
