//
// Copyright(C) 2021 Cloudflare - celso@cloudflare.com
// Copyright(C) 2026 Fragline contributors
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// DESCRIPTION:
//      WebSocket network module for the browser build. Every packet goes
//      through a relay as [to uid][from uid][payload]; the relay strips the
//      "to" field before delivering. Based on Cloudflare's doom-wasm module.
//

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <emscripten.h>
#include <emscripten/websocket.h>

#include "doomtype.h"
#include "i_system.h"
#include "m_argv.h"
#include "m_misc.h"
#include "net_defs.h"
#include "net_packet.h"
#include "net_websockets.h"

#define MAX_QUEUE_SIZE 512
#define MAX_ADDRESSES 64

extern uint32_t instanceUID;

typedef struct
{
    net_packet_t *packets[MAX_QUEUE_SIZE];
    uint32_t froms[MAX_QUEUE_SIZE];
    int head, tail;
} packet_queue_t;

static packet_queue_t queue;

// Peers are identified by uid; each gets one permanent address entry.
static int num_addrs = 0;
static net_addr_t addrs[MAX_ADDRESSES];
static uint32_t uids[MAX_ADDRESSES];

static EMSCRIPTEN_WEBSOCKET_T websocket = 0;
static boolean connected = false;

static void QueuePush(net_packet_t *packet, uint32_t from)
{
    int new_tail = (queue.tail + 1) % MAX_QUEUE_SIZE;

    if (new_tail == queue.head)
    {
        // Queue full: drop the packet; the engine resends what matters.
        NET_FreePacket(packet);
        return;
    }

    queue.packets[queue.tail] = packet;
    queue.froms[queue.tail] = from;
    queue.tail = new_tail;
}

static boolean QueuePop(net_packet_t **packet, uint32_t *from)
{
    if (queue.tail == queue.head)
    {
        return false;
    }

    *packet = queue.packets[queue.head];
    *from = queue.froms[queue.head];
    queue.head = (queue.head + 1) % MAX_QUEUE_SIZE;
    return true;
}

static EM_BOOL WebSocketClose(int eventType, const EmscriptenWebSocketCloseEvent *e, void *userData)
{
    printf("doom: 5, ws close(wasClean=%d, code=%d, reason=%s)\n", e->wasClean, e->code, e->reason);
    connected = false;
    return 0;
}

static EM_BOOL WebSocketError(int eventType, const EmscriptenWebSocketErrorEvent *e, void *userData)
{
    printf("doom: 4, ws error\n");
    return 0;
}

static EM_BOOL WebSocketMessage(int eventType, const EmscriptenWebSocketMessageEvent *e, void *userData)
{
    net_packet_t *packet;
    uint32_t from;

    if (e->isText || e->numBytes < 4)
    {
        return 0;
    }

    from = (uint32_t) e->data[0]
         | (uint32_t) e->data[1] << 8
         | (uint32_t) e->data[2] << 16
         | (uint32_t) e->data[3] << 24;

    packet = NET_NewPacket(e->numBytes - 4);
    memcpy(packet->data, e->data + 4, e->numBytes - 4);
    packet->len = e->numBytes - 4;
    QueuePush(packet, from);
    return 0;
}

static boolean Connect(void)
{
    EmscriptenWebSocketCreateAttributes attr;
    unsigned short ready_state = 0;
    int wss, waited;

    if (connected)
    {
        return true;
    }

    wss = M_CheckParmWithArgs("-wss", 1);
    if (!wss)
    {
        printf("-wss is missing\n");
        return false;
    }

    if (websocket > 0)
    {
        emscripten_websocket_delete(websocket);
        websocket = 0;
    }

    emscripten_websocket_init_create_attributes(&attr);
    attr.url = myargv[wss + 1];
    websocket = emscripten_websocket_new(&attr);
    if (websocket <= 0)
    {
        printf("doom: 1, failed to connect to websockets server\n");
        return false;
    }

    emscripten_websocket_set_onclose_callback(websocket, NULL, WebSocketClose);
    emscripten_websocket_set_onerror_callback(websocket, NULL, WebSocketError);
    emscripten_websocket_set_onmessage_callback(websocket, NULL, WebSocketMessage);

    // Wait up to six seconds for the socket to open, checking often so the
    // lobby is not held up by a fixed one-second poll.
    for (waited = 0; waited < 6000; waited += 25)
    {
        emscripten_websocket_get_ready_state(websocket, &ready_state);
        if (ready_state != 0)
        {
            break;
        }
        emscripten_sleep(25);
    }

    if (ready_state == 1)
    {
        printf("doom: 2, connected to %s\n", attr.url);
        connected = true;
        return true;
    }

    printf("doom: 1, failed to connect to websockets server\n");
    return false;
}

static void SendRaw(uint32_t to, const byte *data, int len)
{
    byte *buffer = malloc(len + 8);

    memcpy(buffer, &to, 4);
    memcpy(buffer + 4, &instanceUID, 4);
    if (len > 0)
    {
        memcpy(buffer + 8, data, len);
    }
    if (emscripten_websocket_send_binary(websocket, buffer, len + 8) < 0)
    {
        printf("doom: 6, failed to send ws packet, reconnecting\n");
        connected = false;
    }
    free(buffer);
}

static boolean NET_Websockets_InitClient(void)
{
    queue.head = queue.tail = 0;
    return Connect();
}

static boolean NET_Websockets_InitServer(void)
{
    queue.head = queue.tail = 0;
    if (!Connect())
    {
        return false;
    }
    // Announce the server to the relay so clients can reach uid 1.
    SendRaw(0, NULL, 0);
    return true;
}

static void NET_Websockets_SendPacket(net_addr_t *addr, net_packet_t *packet)
{
    if (addr->handle == NULL || !Connect())
    {
        return;
    }
    SendRaw(*(uint32_t *) addr->handle, packet->data, packet->len);
}

static net_addr_t *FindAddress(uint32_t uid)
{
    int i;

    for (i = 0; i < num_addrs; ++i)
    {
        if (uids[i] == uid)
        {
            return &addrs[i];
        }
    }
    if (num_addrs >= MAX_ADDRESSES)
    {
        printf("doom: 3, we're out of client addresses\n");
        return NULL;
    }
    uids[num_addrs] = uid;
    addrs[num_addrs].refcount = 1;
    addrs[num_addrs].module = &net_websockets_module;
    addrs[num_addrs].handle = &uids[num_addrs];
    return &addrs[num_addrs++];
}

static boolean NET_Websockets_RecvPacket(net_addr_t **addr, net_packet_t **packet)
{
    uint32_t from;

    if (!Connect())
    {
        return false;
    }

    while (QueuePop(packet, &from))
    {
        *addr = FindAddress(from);
        if (*addr != NULL)
        {
            return true;
        }
        NET_FreePacket(*packet);
    }
    return false;
}

static void NET_Websockets_AddrToString(net_addr_t *addr, char *buffer, int buffer_len)
{
    M_snprintf(buffer, buffer_len, "ws client %u", *(uint32_t *) addr->handle);
}

static void NET_Websockets_FreeAddress(net_addr_t *addr)
{
    // Address entries live in a static table and are reused for the session.
}

// Only used to resolve the server, whose uid is always 1.
static net_addr_t *NET_Websockets_ResolveAddress(const char *address)
{
    return FindAddress((uint32_t) atoi(address));
}

net_module_t net_websockets_module =
{
    NET_Websockets_InitClient,
    NET_Websockets_InitServer,
    NET_Websockets_SendPacket,
    NET_Websockets_RecvPacket,
    NET_Websockets_AddrToString,
    NET_Websockets_FreeAddress,
    NET_Websockets_ResolveAddress,
};
