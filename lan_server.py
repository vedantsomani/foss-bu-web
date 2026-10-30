"""Serve the browser game and its two-player relay entirely on local Wi-Fi."""
import argparse
import asyncio
import json
import mimetypes
import secrets
import socket
import struct
import time
from pathlib import Path
from urllib.parse import urlsplit

from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

PUBLIC = Path(__file__).resolve().parent / 'public'
ROOMS = {}
ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'


def response(status, body, content_type='application/json'):
    if not isinstance(body, bytes):
        body = body.encode('utf-8')
    return Response(status, {200: 'OK', 400: 'Bad Request', 404: 'Not Found',
                             409: 'Conflict', 405: 'Method Not Allowed'}[status],
                    Headers({'Content-Type': content_type, 'Content-Length': str(len(body)),
                             'Cache-Control': 'no-cache'}), body)


def room_for(code):
    room = ROOMS.get(code)
    return room if room and time.monotonic() - room['created'] < 43200 else None


async def route(connection, request):
    path = urlsplit(request.path).path
    parts = path.strip('/').split('/')
    if path == '/api/newroom':
        for key in list(ROOMS):
            if not room_for(key) and not ROOMS[key]['sockets']:
                del ROOMS[key]
        code = ''.join(secrets.choice(ALPHABET) for _ in range(8))
        while code in ROOMS:
            code = ''.join(secrets.choice(ALPHABET) for _ in range(8))
        ROOMS[code] = {'created': time.monotonic(), 'started': False, 'sockets': set(), 'players': {}}
        return response(200, json.dumps({'room': code}))
    if len(parts) >= 3 and parts[:2] in (['api', 'room'], ['api', 'ws']):
        room = room_for(parts[2])
        if not room:
            return response(404, '{"error":"Room not found or expired"}')
        if parts[1] == 'room':
            if parts[3:] == ['started']:
                room['started'] = True
            return response(200, json.dumps({'room': parts[2], 'gameStarted': room['started']}))
        if request.headers.get('Upgrade', '').lower() != 'websocket':
            return response(400, '{"error":"WebSocket required"}')
        if room['started'] or len(room['sockets']) >= 2:
            return response(409, '{"error":"Room full or already started"}')
        # Reserve before yielding to the handshake so simultaneous joins cannot overfill.
        room['sockets'].add(connection)
        connection.arena_room = room
        return None
    if path.startswith('/api/'):
        return response(404, '{"error":"Invalid room"}')
    if path == '/' or (len(parts) == 1 and len(parts[0]) == 8 and all(c in ALPHABET for c in parts[0])):
        path = '/index.html'
    candidate = (PUBLIC / path.lstrip('/')).resolve()
    if not candidate.is_relative_to(PUBLIC) or not candidate.is_file():
        return response(404, 'Not found', 'text/plain')
    kind = 'application/wasm' if candidate.suffix == '.wasm' else mimetypes.guess_type(candidate.name)[0] or 'application/octet-stream'
    return response(200, await asyncio.to_thread(candidate.read_bytes), kind)


async def relay(connection):
    room = connection.arena_room
    identity = None
    count, epoch = 0, time.monotonic()
    try:
        async for packet in connection:
            if time.monotonic() - epoch > 1:
                count, epoch = 0, time.monotonic()
            count += 1
            if count > 500:
                await connection.close(1008, 'Message limit')
                break
            if not isinstance(packet, bytes) or not 8 <= len(packet) <= 65536:
                await connection.close(1003, 'Invalid packet')
                break
            destination, sender = struct.unpack_from('<II', packet)
            if (identity is not None and identity != sender) or (sender in room['players'] and room['players'][sender] is not connection):
                await connection.close(1008, 'Invalid identity')
                break
            identity = sender
            room['players'][sender] = connection
            target = room['players'].get(destination)
            if target:
                await target.send(packet[4:])
    finally:
        room['sockets'].discard(connection)
        if identity is not None and room['players'].get(identity) is connection:
            del room['players'][identity]


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(('192.0.2.1', 1))
            return probe.getsockname()[0]
    except OSError:
        return socket.gethostbyname(socket.gethostname())


async def main(port):
    async with serve(relay, '0.0.0.0', port, process_request=route,
                     compression=None, max_size=65536, ping_interval=20, close_timeout=2):
        print(f'FOSS-BU local Wi-Fi game: http://{lan_ip()}:{port}/', flush=True)
        print('Open this link on BOTH laptops, then create/share a room. Keep this window open.', flush=True)
        print('If asked by Windows, allow Python on your private network. Press Ctrl+C to stop.', flush=True)
        await asyncio.Future()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    try:
        asyncio.run(main(parser.parse_args().port))
    except KeyboardInterrupt:
        pass
