//
// Copyright(C) 1993-1996 Id Software, Inc.
// Copyright(C) 2005-2014 Simon Howard
// Copyright(C) 2014-2017 Fabian Greffrath
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// DESCRIPTION:
//	Crispy Doom specific variables.
//


#include "crispy.h"

// [crispy] "regular" config variables
static crispy_t crispy_s = {
	0,
	.extautomap = 1,
	.gamma = 9,  // default level is "OFF" for intermediate gamma levels
	.hires = 1,
	.soundfix = 1,
#ifdef CRISPY_TRUECOLOR
	.smoothlight = 1,
	.truecolor = 1,
#endif
	.vsync = 1,
	.widescreen = 1, // match screen by default
};
crispy_t *const crispy = &crispy_s;

// [crispy] "critical" config variables
static const crispy_t critical_s = {0};
const crispy_t *critical = &critical_s;

// [crispy] update the "singleplayer" variable and the "critical" struct
// [fragline] Gameplay options shared by everyone in a network game. Every
// player runs the same build, so modern aiming and jumping are safe to allow;
// they are fixed here, not read from each player's settings, to keep every
// copy of the game in sync.
static const crispy_t netgame_s = {
	.freeaim = FREEAIM_DIRECT,
	.jump = JUMP_LOW,
};
boolean crispy_netgame = false;

void CheckCrispySingleplayer (boolean singleplayer)
{
	if ((crispy->singleplayer = singleplayer))
	{
		critical = &crispy_s;
	}
	else
	{
		critical = crispy_netgame ? &netgame_s : &critical_s;
	}
}

// [fragline] Keep every option the engine uses as a table index or a size inside
// its valid range. Config files are plain text, so a corrupt or hand-edited value
// (a negative number, 99999, ...) would otherwise read past the end of a table.
// Called once, right after the config files are loaded.
typedef struct { int *var; int min; int max; } clamp_t;

void CRISPY_ClampConfig (void)
{
	const clamp_t limits[] = {
		{&crispy->automapoverlay, 0, 2}, {&crispy->automaprotate, 0, 1}, {&crispy->automapstats, 0, NUM_WIDGETS - 1},
		{&crispy->bobfactor, 0, NUM_BOBFACTORS - 1}, {&crispy->btusetimer, 0, 1}, {&crispy->brightmaps, 0, NUM_BRIGHTMAPS - 1},
		{&crispy->centerweapon, 0, NUM_CENTERWEAPON - 1}, {&crispy->coloredblood, 0, NUM_COLOREDBLOOD - 1},
		{&crispy->coloredhud, 0, NUM_COLOREDHUD - 1}, {&crispy->crosshair, 0, NUM_CROSSHAIRS - 1},
		{&crispy->crosshairhealth, 0, 1}, {&crispy->crosshairtarget, 0, 1}, {&crispy->crosshairtype, -1, 2},
		{&crispy->defaultskill, 0, NUM_SKILLS - 1}, {&crispy->demobar, 0, 1}, {&crispy->demotimer, 0, NUM_DEMOTIMERS - 1},
		{&crispy->demotimerdir, -1, 1}, {&crispy->extautomap, 0, 1}, {&crispy->flipcorpses, 0, 1},
		{&crispy->fpslimit, 0, 1000}, {&crispy->freeaim, 0, NUM_FREEAIMS - 1}, {&crispy->freelook, 0, NUM_FREELOOKS - 1},
		{&crispy->gamma, 0, 17}, {&crispy->hires, 0, 1}, {&crispy->jump, 0, NUM_JUMPS - 1}, {&crispy->leveltime, 0, NUM_WIDGETS - 1},
		{&crispy->mouselook, 0, 1}, {&crispy->neghealth, 0, 1}, {&crispy->overunder, 0, 1}, {&crispy->pitch, 0, 1},
		{&crispy->playercoords, 0, NUM_WIDGETS - 1}, {&crispy->secretmessage, 0, NUM_SECRETMESSAGE - 1},
		{&crispy->smoothlight, 0, 1}, {&crispy->smoothmap, 0, 1}, {&crispy->soundfix, 0, 1}, {&crispy->soundfull, 0, 1},
		{&crispy->soundmono, 0, 1}, {&crispy->statsformat, 0, NUM_STATSFORMATS - 1}, {&crispy->translucency, 0, NUM_TRANSLUCENCY - 1},
#ifdef CRISPY_TRUECOLOR
		{&crispy->truecolor, 0, 1},
#endif
		{&crispy->uncapped, 0, 1}, {&crispy->vsync, 0, 1}, {&crispy->widescreen, 0, NUM_RATIOS - 1},
	};
	unsigned int i;

	for (i = 0; i < sizeof(limits) / sizeof(*limits); i++)
	{
		if (*limits[i].var < limits[i].min || *limits[i].var > limits[i].max)
		{
			*limits[i].var = 0;
		}
	}
}
