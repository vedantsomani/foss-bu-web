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
