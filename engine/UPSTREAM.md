# Engine upstream

`engine/crispy-doom/` is Crispy Doom (GPL-2.0-or-later), imported from
https://github.com/fabiangreffrath/crispy-doom at commit
`fdeabe4c23a833534b70aa84a22f1685aae7125d` (version 7.2.0 development, 2026-10-12).

Only the parts needed to build Doom for the browser were imported: the shared
engine code and `src/doom`, plus `textscreen`, `opl` and `pcsound`. The Heretic,
Hexen, Strife and setup programs, platform packaging and build files were left out.

Fragline's changes are in the commits after the import. See `engine/README.md`.
