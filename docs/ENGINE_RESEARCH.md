# Doom source ports: research for the Fragline lab engine

Scope: ideas for `public/lab/` (JS/WebGL2, host-authoritative 60 Hz sim, client prediction, snapshot interpolation, lag compensation, `classic` and `modern` rulesets). Ideas only: no port's code is to be copied (see "Licensing").

Method and caveats. Only GitHub pages could be fetched directly; doomwiki.org, zandronum.com, odamex.net, doomworld.com and the Valve wiki were unreachable from this session, so claims from them rest on search-result summaries (marked "via search"). Anything I could not confirm is flagged **unverified**. Opinions ("what players love") are drawn from forum snippets and feature lists, not from a survey.

## 1. Ports at a glance

| Port | Players like | Multiplayer model | License |
|---|---|---|---|
| **Chocolate Doom** ([repo](https://github.com/chocolate-doom/chocolate-doom)) | Faithful vanilla behaviour including bugs, DOS-compatible demos/configs/saves; a Doomworld poster rates its mouse feel among the best for classic Doom (via search, [post](https://doomworld.com/forum/post/2783398)) | Lockstep ticcmd model (Doom's original); Chocolate adds temporal compression of ticcmds (via search, [Doomworld](https://www.doomworld.com/forum/post/1297379), [Ticdup](https://doomwiki.org/wiki/Ticdup)) | GPL (README links GPL-2.0) |
| **Crispy Doom** ([repo](https://github.com/fabiangreffrath/crispy-doom)) | Chocolate-faithful but with 640x400, widescreen to 24:9, uncapped interpolated framerate, optional jump/mouselook/crosshair, translucent HUD, limit removal | Same as Chocolate (net-compatible by design) | GPL-2.0 |
| **Woof!** ([repo](https://github.com/fabiangreffrath/woof)) | MBF21 default, UMAPINFO 2.2, arbitrary resolution + dynamic resolution scaling, uncapped interpolation, FOV, 3D/HRTF audio, OPL3 and FluidSynth music, PC speaker emulation, gamepad with gyro/flick stick | Integrates Chocolate's netcode (lockstep) | GPL-2.0 (some bundled files other licenses) |
| **Nugget Doom** ([repo](https://github.com/MrAlaux/Nugget-Doom)) | Woof! fork with quality-of-life: NUGHUD (custom HUD lump), message list, true-color lighting, radial fog, sprite shadows, bobbing styles, damage/bonus tint caps, jump/crouch, freecam, hitbox-based hitscan, smart autoaim, slow-motion | Inherits Woof | GPL-2.0 |
| **DSDA-Doom** ([repo](https://github.com/kraflab/dsda-doom)) | Speedrun/demo tooling: in-game console, strict mode, TAS tools, rewind, MBF21/UMAPINFO, palette-based OpenGL renderer; a Doomworld poster says its mouse feel is good only with the OpenGL renderer (via search) | Not a netplay focus (not verified) | Not stated on the repo page; **unverified** (check LICENSE) |
| **Odamex** ([repo](https://github.com/odamex/odamex)) | Online-first: up to 255 players, vanilla/Boom/ZDoom compat flags, netdemos, in-engine WAD downloader, 32-bit renderer, DM/TDM/CTF/Attack-Defend/Horde/Survival/LMS/LTS/LMS-CTF/3-way CTF, warmup, rounds, player queue | **Client/server with prediction, interpolation and "unlagged"** (backwards reconciliation, all hitscan except BFG tracers; via search, [wiki](https://www.odamex.net/wiki/Unlagged), [Network Settings](https://odamex.net/wiki/Network_Settings)) | GPL-2.0 |
| **Zandronum** ([wiki](https://wiki.zandronum.com/Game_modes), [Q-Zandronum notes](https://github.com/IgeNiaI/Q-Zandronum/wiki/How-to-make-your-mod-feel-lagless-in-multiplayer)) | Large modded online scene, server browser, modes: DM, TDM, Duel, LMS/TeamLMS, CTF, Terminator, Domination, Possession, Invasion/Survival | **Server-authoritative; client predicts own movement; server keeps ~2 s of position history and rewinds other players by shooter ping for hitscan** (Q-Zandronum extends to projectiles). Switched from ping-based to tic-based unlagged in 1.4 (via search, [tracker](https://zandronum.com/tracker/view.php?id=3334)) | Custom Sleepycat-based 4-clause license, described as GPL-compatible in one direction (via search, [license](https://wiki.zandronum.com/License)) |
| **GZDoom / UZDoom** ([UZDoom](https://github.com/UZDoom/UZDoom)) | Dynamic lights, 3D floors, Vulkan/GL, huge mod ecosystem (DECORATE/ZScript/MAPINFO) | Multiplayer not covered by sources fetched; **unverified** (ZDoom lineage historically peer-to-peer lockstep, Zandronum forked for client/server) | GPLv3+ since GZDoom 3.0.0 (via search, [DoomWiki](https://www.doomwiki.org/wiki/GZDoom)). UZDoom forked Oct 2025 after a dispute over AI-generated code ([TechSpot](https://www.techspot.com/news/109864-gzdoom-developers-split-creator-amid-ai-controversy-launch.html)) |
| **Eternity** | Boom-compatible, ACS, EDF, UDMF | Not documented in what I found | GPLv3+ (via search, [DoomWiki](https://www.doomwiki.org/wiki/Eternity_Engine)) |
| **ZDaemon** | Multiplayer-focused ZDoom derivative: enhanced client/server netcode, DM/TDM/CTF/Duel/King of the Hill, demos, stats | Client/server | Doom Source License / BSD mix, closed-source disputes; **status unsettled** (via search, [DoomWiki](https://doomwiki.org/wiki/ZDaemon)) |
| **QuakeWorld** (comparison) | The model modern FPS netcode descends from | Separate client/server; Carmack added client-side prediction in 1996 because original Quake assumed low latency (via search, [QuakeWorld history](https://quakeworld.nu/wiki/The_History_of_QuakeWorld)) | GPL (id release; not re-verified here) |

Takeaway: Fragline's chosen architecture (authoritative server, prediction, interpolation, rewind for hitscan) is the same family as Odamex, Zandronum, ZDaemon and QuakeWorld. Chocolate/Crispy/Woof/DSDA are lockstep and only relevant for feel and presentation.

## 2. Topic findings

### Movement and strafing
- Verified vanilla constants (via search, [DoomWiki Friction](https://doomwiki.org/wiki/Friction), [ZDoom forum](https://forum.zdoom.org/viewtopic.php?p=150740), PCDoom/SMMU source excerpts): friction `0xE800` (59392/65536 = 90.625% momentum kept per 35 Hz tic), `STOPSPEED 0x1000`, `MAXMOVE 30*FRACUNIT` (momentum clamp), thrust of about 0.03125 map units per tic^2 per unit of command (`cmd*2048` in 16.16 fixed). Friction applies only on the ground, so air control is whatever momentum you carry.
- Command values (forward 25/50, side 24/40) are from my knowledge of the vanilla source and match `public/lab/game/rules.js`; I did not re-verify them online.
- **Straferunning**: forward and sideways thrust add as a vector, so diagonal running is faster than straight running. SR40 uses side 40 (the normal run strafe). **SR50** exploits the engine adding several strafe inputs and clamping at 50; it is awkward and, in vanilla, cannot be combined with turning; a 2015 tool (SR50.EXE) automates it (via search, [DoomWiki SR50](https://doomwiki.org/wiki/SR50)).
- Players of classic DM treat straferunning and SR50 as skill expression; ports differ in whether they preserve it (Chocolate and DSDA keep vanilla physics; ZDoom-family ports changed some physics).
- Crispy and Nugget add optional jumping (Nugget also crouching); both are off by default in Crispy per its README (Nugget's default is unverified).

### Weapon feel and combat pacing
- Vanilla feel comes from state-machine timings (lower/raise ~16+16 tics, refire inaccuracy, SSG's slow reload) plus pickup-and-stay weapons. Fragline's `classic` ruleset already encodes these.
- Players praise port options that do not alter timing: weapon bob styles and bonus/damage tint caps (Nugget), hitbox-based hitscan and smart autoaim (Nugget; effect on competitive balance **unverified**).
- Autoaim vs mouselook is a recurring divide: vanilla vertical autoaim lets mouselook-less play work; Crispy/Woof/Nugget add free look and the community keeps it optional in DM.

### Mouse responsiveness
- Doomworld snippets: a raw-input option has a clear effect on latency in regular (non-shorttic) play; up to ~1 ms less input lag with uncapped fps was reported for one port; sensitivity-1 scaling between SDL and the engine could drop input (via search; low-confidence anecdotes, not benchmarks).
- Classic ports quantise turning to 35 Hz tics; "carry fractional tics" and shorttics threads exist to reduce that stutter. Interpolated, uncapped rendering (Crispy, Woof, Odamex, DSDA GL) is the single most cited smoothness feature.
- Fragline already applies mouse every display frame; keep input sampling decoupled from sim tick and send high-resolution yaw/pitch in commands.

### Hit registration
- **Backwards reconciliation** (Odamex "unlagged", Zandronum, Source, Q3 "unlagged" mod): server stores recent positions and rewinds targets by the shooter's latency before a hitscan test (via search, [Valve](https://developer.valvesoftware.com/wiki/Lag_Compensation): one second of history by default, `sv_maxunlag`).
- Zandronum details (verified from [Q-Zandronum wiki](https://github.com/IgeNiaI/Q-Zandronum/wiki/How-to-make-your-mod-feel-lagless-in-multiplayer)): about 2 s history, rewind by shooter ping, restore after the test; players only by default; projectiles are not rewound in base Zandronum, only simulated forward in Q-Zandronum; client-spawned actors can desync if net IDs or RNG differ; self-damage from predicted explosions is delayed on the server.
- Odamex: unlagged covers all hitscan except BFG tracers; players can opt out client-side; early versions did not rewind monsters (via search; may be outdated).
- Zandronum's developers reported blind tests where players could not tell ping-based from tic-based unlagged, or preferred tic-based (via search, tracker). Fragline's tick-based `lagComp` with a rewind cap (`host.js`, `maxRewindMs = 200`) matches that.

### Multiplayer sync and anti-cheat
- Lockstep: every peer must have every player's ticcmd before a tic advances, so one slow player stalls all (via search, Doomworld). Deterministic, cheap to cheat-proof only by trusting all peers (any client can run modified code), which is why server-authoritative ports exist.
- Server-authoritative ports validate movement and hits server-side; clients only send inputs. For Fragline, anti-cheat is mostly structural: never trust client position or hit claims, cap rewind, rate-limit and sanity-check commands (view-angle deltas, fire rate). Specific anti-cheat features in Odamex/Zandronum (bans, ban lists, wallhack handling) were not verified.
- Desync debugging aids worth mirroring: Zandronum's net-ID and RNG print cvars.

### Deathmatch map design
Sources are community forum/wiki tips, not a canon (via search, [DoomWiki tips](https://doomwiki.org/wiki/Tips_for_creating_good_WADs), Doomworld threads):
- Spread weapons across sections; put at least one weapon near each DM start.
- No single weapon should dominate; maps should support all weapons including BFG; match layout to weapons (tight for hitscan, open for projectiles).
- Duplicate key weapons/powerups so camping one spot does not control the map.
- Good flow: few dead ends, avoid door-heavy chains (doors slow movement), shortcut loops; distinguish arena maps from item-control maps.
- Spawn rules: vanilla picks a random DM start and falls back to a co-op start if all are blocked (via search, [DoomWiki](https://www.doomwiki.org/wiki/Respawn)). I could not verify the vanilla item respawn time of 30 s online.
- Classic modes: DM 1.0 (weapons stay, no item respawn), "altdeath" (items respawn, weapons do not stay); see [ZDoom dmflags](https://zdoom.org/wiki/Dmflags).

### Graphics and lighting
- Liked: uncapped interpolation, widescreen with correct HUD scaling, dynamic resolution scaling and FOV (Woof), true-color lighting and sprite shadows (Nugget), Crispy's 640x400 sharpening, gamma steps, translucent HUD.
- Palette vs true-color: DSDA offers a palette-based GL renderer to keep the look; Nugget adds true-color lighting as an option. Fragline's WebGL2 renderer already does sector light and bloom; classic purists want the colormap look preserved.
- Brightmaps and sector light smoothing: I could not verify specific implementations in the fetched pages (Woof's page did not mention them); treat as **unverified** ports features and design independently.

### Sound
- Woof: 3D positional audio with stereo up to 7.1 and optional HRTF, PC speaker emulation, OPL3 emulator, FluidSynth, MUSINFO and SNDINFO ambient sounds.
- Community likes OPL-flavoured music (DMX sound) and an authentic PC speaker toggle; both are choice features. Full-length sounds (Crispy) avoid vanilla's cutoff.

### HUD
- Crispy: minimal HUD, colorized numbers, translucency, crosshair. Nugget: NUGHUD lump for fully custom HUDs, message list. Woof HUD widget details were not in the fetched page (**unverified**).
- Practical: crosshair style/colour/health-reactive options, kill feed/message list, frag/time limit, net stats, FPS.

### Performance
- Dynamic resolution (Woof), uncapped frame rate, palette GL path (DSDA). Browser analogue: dynamic resolution (done), no per-frame allocation (done), worker rendering (planned).

### Mod support
- DEHACKED/BEX (Crispy, Odamex, Woof), MBF21 v1.4 and UMAPINFO v2.2 (Woof, DSDA, Odamex: MBF21), MUSINFO/ANIMATED/SWITCHES (Crispy). Boom generalized specials are not in Crispy/Chocolate. Odamex has an in-engine WAD downloader; Eternity has EDF and ACS.

### Game modes, voting, rotation
- Odamex: warmup, rounds, player queue, LMS/LTS, team CTF variants. Zandronum: Duel with a waiting line, LMS with lives, Domination (point every 3 s per held point), Possession, Terminator (via search, [Zandronum wiki](https://wiki.zandronum.com/Game_modes)).
- Voting (callvote) and map rotation exist in both, but I found no source describing specifics: **unverified**.
- Spectator and queue-based duel are widely used in competitive servers (specifics unverified).

## 3. Feature comparison

| Feature | Chocolate | Crispy | Woof! | Nugget | DSDA | Odamex | Zandronum | GZ/UZDoom | Fragline lab |
|---|---|---|---|---|---|---|---|---|---|
| Netcode | lockstep | lockstep | lockstep | lockstep | n/a | client/server | client/server | peer/lockstep (unv.) | host-auth |
| Client prediction | no | no | no | no | no | yes | yes | n/a | yes |
| Unlagged hitscan | no | no | no | no | no | yes | yes | no | yes |
| Uncapped interpolated fps | no | yes | yes | yes | yes | yes | yes | yes | yes |
| Mouselook | no | optional | yes | yes | yes | yes | yes | yes | yes |
| Raw mouse input | SDL option | SDL option | yes (not verified) | same | yes | yes | yes | yes | yes where available |
| Vanilla physics option | yes | yes | yes | yes | yes | compat flags | partial | partial | classic ruleset |
| True-color / smooth light | no | no | unverified | true-color | palette GL | 32-bit | yes | yes | yes |
| MBF21 / UMAPINFO | no | no | yes | yes | yes | MBF21 | partial | partial | no |
| HUD customization | low | medium | medium | NUGHUD | medium | medium | ACS/ZScript | high | basic |
| Team / CTF / LMS | no | no | no | no | no | yes | yes | no | planned |
| License | GPL | GPL-2.0 | GPL-2.0 | GPL-2.0 | unverified | GPL-2 | custom | GPLv3+ | n/a |

## 4. Adopt in Fragline

C = Classic-safe (leaves vanilla feel, rules and demos' spirit untouched). M = Optional-modern (setting or `modern` ruleset only). Order is priority.

1. **C** Keep `classic` ruleset physics locked to vanilla constants (friction 0xE800, thrust, STOPSPEED, MAXMOVE clamp) and expose it in the lobby; run a test that steady-state speeds and SR40 match an independent reference calculation.
2. **C** Decouple look input from sim tick (done) and add raw-input toggle, sensitivity curve and optional "carry fractional turn" for perfect-repeatable angle quantisation in `classic`.
3. **C** Lag compensation as tick-based rewind with a capped window and server-side clamp (present); add a client opt-out and visible "rewind used" debug HUD.
4. **C** Command validation on the host: clamp turn rate, fire rate, move magnitude, reject out-of-order sequence, ban on repeated violations.
5. **C** Deterministic seeded RNG shared between predicted and authoritative events so predicted impacts/sounds match (avoid the Zandronum RNG desyncs).
6. **C** Prediction-safe self-damage and pickups: show predicted effects only for cosmetics, wait for server confirmation for health/ammo.
7. **C** Spawn fairness: random spawn from DM starts weighted away from recent deaths and enemy line of sight, spawn protection (present, 180 ticks), fallback to co-op starts.
8. **C** Authentic DM rules switches: weapons-stay vs altdeath item respawn as lobby options.
9. **C** Interpolated uncapped rendering with weapon bob toggles and status-bar widgets matching vanilla layout.
10. **C** Positional audio with proper occlusion-free distance falloff plus stereo separation as in vanilla; optional PC-speaker and OPL-style music via WebAudio synth.
11. **C** Game modes with minimal rule surface: DM, TDM, Duel (queue, winner stays), LMS, CTF; warmup and ready-up like Odamex.
12. **C** Map rotation and a simple vote (next map, restart) with cooldown; show vote UI in HUD.
13. **C** Spectator and demo recording (inputs + snapshot keyframes) so matches can be replayed for review.
14. **M** Free look with crosshair and optional vertical autoaim, defaulting off in `classic`.
15. **M** Dynamic resolution and FOV slider with Hor+ widescreen (present or planned).
16. **M** Sprite shadows, damage/bonus tint caps, bob style options (inspired by Nugget).
17. **M** HUD layout file (JSON, NUGHUD-style idea) letting players move/resize widgets: crosshair, health/armor, kill feed, net stats.
18. **M** Gamepad aim options (response curves, deadzones, gyro/flick stick) following Woof's list of options.
19. **M** Jump/crouch only in `modern` ruleset; projectiles rewound only if measured as needed (Q-Zandronum cost warning).
20. **M** Mod hooks: read UMAPINFO/MBF21 subsets or a JSON map-info lump for episode flow and music, without full DEHACKED.

## 5. Avoid
- Copying code from any port. GPL-2.0 (Chocolate, Crispy, Woof, Nugget, Odamex) and GPLv3+ (GZDoom/UZDoom, Eternity) code cannot be mixed into a differently licensed codebase; Zandronum's license is custom and ZDaemon's status is unsettled. Clean-room from described behaviour only.
- Lockstep netcode, vanilla's single hidden-tab stall, and trusting client-reported hits.
- Rewinding everything (monsters, projectiles, doors) by default; start with players and hitscan only.
- Requiring SR50 skill or turn-restricted tricks to be competitive; keep it a natural result of physics, not a hidden input exploit.
- Overloading DM maps with mod ecosystem features (ZScript-style scripting) in the engine core.
- Relying on forum anecdotes about mouse feel; measure input-to-photon latency instead.
- Code provenance risk: the UZDoom split shows AI-generated code can raise licensing disputes; log where your own code originates.
