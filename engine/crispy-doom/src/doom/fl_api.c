//
// [fragline] Diagnostics and test hooks exported to the web page.
//
// The page reads a few numbers (map, health, weapon, heap use) to show and
// test what the engine is doing. The commands that change the game only work
// in single-player: they cannot be used to cheat in a network game.
//

#include <emscripten.h>
#include <malloc.h>

#include "doomstat.h"
#include "d_player.h"
#include "d_loop.h"
#include "g_game.h"
#include "p_local.h"
#include "m_menu.h"
#include "hu_stuff.h"
#include "i_video.h"
#include "crispy.h"

extern short itemOn; // menu item the skull is on (m_menu.c)

EMSCRIPTEN_KEEPALIVE int fl_state(int what)
{
    player_t *p = &players[consoleplayer];

    switch (what)
    {
        case 0: return gametic;
        case 1: return (int) gamestate;
        case 2: return gamemap;
        case 3: return p->health;
        case 4: return (int) p->readyweapon;
        case 5: return (int) p->pendingweapon;
        case 6: return (int) p->playerstate;
        case 7: return leveltime;
        case 8: return menuactive;
        case 9: return automapactive;
        case 10: return netgame;
        case 11: return p->frags[consoleplayer];
        case 12: return p->mo != NULL;
        case 13: return p->armorpoints;
        case 14: return paused;
        case 15: return usergame;
        case 16: return p->ammo[0];
        case 17: return p->ammo[1];
        case 18: return p->ammo[2];
        case 19: return p->ammo[3];
        case 20: return p->mo ? p->mo->x : 0;
        case 21: return p->mo ? p->mo->y : 0;
        case 22: return p->mo ? p->mo->angle : 0;
        case 23: return (int) mallinfo().uordblks;   // bytes allocated through malloc
        case 24: return (int) mallinfo().arena;       // bytes obtained from the system
        case 25: return p->lookdir;
        case 26: return p->killcount;
        case 27: return p->mo ? p->mo->z : 0;
        case 28: return p->mo ? p->mo->momz : 0;
        // the last tic command: what the player's input turned into
        case 29: return p->cmd.buttons;
        case 30: return p->cmd.forwardmove;
        case 31: return p->cmd.sidemove;
        case 32: return p->cmd.angleturn;
        case 33: return p->cmd.arti;
        case 34: return p->cmd.lookdir;
        case 35: return chat_on;
        case 36: return screenblocks;
        case 37: return SCREENWIDTH;
        case 38: return SCREENHEIGHT;
        case 39: return crispy->hires;
        case 40: return crispy->truecolor;
        case 41: return crispy->widescreen;
        case 42: return crispy->crosshair;
        case 43: return crispy->uncapped;
        case 44: return p->usedown;
        case 45: return p->attackdown;
        case 46: return p->itemcount;
        case 47: return totalkills;
        case 48: return itemOn;
        default:
            if (what >= 100 && what < 100 + NUMWEAPONS)
            {
                return p->weaponowned[what - 100];
            }
            return -1;
    }
}

EMSCRIPTEN_KEEPALIVE int fl_command(int what, int arg)
{
    player_t *p = &players[consoleplayer];

    if (netgame || gamestate != GS_LEVEL || p->mo == NULL)
    {
        return -1;
    }

    switch (what)
    {
        case 1: // end the level, as an exit switch does
            G_ExitLevel();
            return 0;
        case 2: // die
            P_DamageMobj(p->mo, NULL, NULL, 10000);
            return 0;
        default:
            return -1;
    }
}
