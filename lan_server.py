"""Serve Fragline and its room relay entirely on a local network (no Internet needed).

The HTTP API and relay rules match src/index.mjs (the Cloudflare version), so the
same browser code works against either server.
"""
import argparse
import asyncio
import gzip
import hashlib
import json
import mimetypes
import secrets
import socket
import struct
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Response

PUBLIC = Path(__file__).resolve().parent / 'public'
ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
ROOM_TTL = 12 * 60 * 60
MAX_ROOMS = 200
IDLE_TIMEOUT = 60
MIN_PLAYERS, MAX_PLAYERS = 2, 4
API_HEADER = 'X-Fragline'
COMPRESSIBLE = {'.wad', '.wasm', '.js', '.css', '.html', '.cfg', '.txt', '.json', '.svg'}
NO_CACHE = {'.html'}
STATUS = {200: 'OK', 304: 'Not Modified', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found',
          409: 'Conflict', 503: 'Service Unavailable'}

ROOMS = {}
FILES = {}


def response(status, body=b'', content_type='application/json', headers=()):
    if not isinstance(body, bytes):
        body = body.encode('utf-8')
    head = Headers({'Content-Type': content_type, 'Content-Length': str(len(body)),
                    'Cache-Control': 'no-store' if content_type == 'application/json' else 'no-cache'})
    for key, value in headers:
        head[key] = value
    return Response(status, STATUS[status], head, body)


def api(status, data):
    return response(status, json.dumps(data))


def is_room_code(code):
    return len(code) == 8 and all(c in ALPHABET for c in code)


def room_for(code):
    room = ROOMS.get(code)
    return room if room and time.monotonic() - room['created'] < ROOM_TTL else None


def room_status(code, room):
    return {'room': code, 'started': room['started'], 'players': len(room['players']),
            'maxPlayers': room['max']}


def load_file(path):
    """Read a static file once and keep it, with a gzip copy when that saves space."""
    stat = path.stat()
    cached = FILES.get(path)
    if cached and cached['mtime'] == stat.st_mtime_ns:
        return cached
    data = path.read_bytes()
    packed = gzip.compress(data, 6, mtime=0) if path.suffix in COMPRESSIBLE else None
    if packed is not None and len(packed) >= len(data) * 0.9:
        packed = None
    kind = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
    if path.suffix == '.wasm':
        kind = 'application/wasm'
    elif path.suffix in ('.cfg', '.txt'):
        kind = 'text/plain; charset=utf-8'
    elif kind.startswith('text/') or kind == 'application/javascript':
        kind += '; charset=utf-8'
    cached = {'mtime': stat.st_mtime_ns, 'data': data, 'gzip': packed, 'type': kind,
              'etag': '"' + hashlib.sha256(data).hexdigest()[:20] + '"'}
    FILES[path] = cached
    return cached


async def static(request, path):
    if path == '/' or is_room_code(path.strip('/')):
        path = '/index.html'
    candidate = (PUBLIC / path.lstrip('/')).resolve()
    if not candidate.is_relative_to(PUBLIC) or not candidate.is_file():
        return response(404, 'Not found', 'text/plain; charset=utf-8')
    entry = await asyncio.to_thread(load_file, candidate)
    extra = [('ETag', entry['etag']), ('Vary', 'Accept-Encoding')]
    if candidate.suffix not in NO_CACHE and candidate.name != 'sw.js':
        extra.append(('Cache-Control', 'public, max-age=300'))
    if request.headers.get('If-None-Match') == entry['etag']:
        return response(304, b'', entry['type'], extra)
    if entry['gzip'] is not None and 'gzip' in request.headers.get('Accept-Encoding', ''):
        return response(200, entry['gzip'], entry['type'], extra + [('Content-Encoding', 'gzip')])
    return response(200, entry['data'], entry['type'], extra)


def new_room(query):
    for key in list(ROOMS):
        if not room_for(key) and not ROOMS[key]['sockets']:
            del ROOMS[key]
    if len(ROOMS) >= MAX_ROOMS:
        return api(503, {'error': 'Too many open rooms. Try again later.'})
    try:
        players = int(query.get('players', ['2'])[0])
    except ValueError:
        players = 2
    players = min(max(players, MIN_PLAYERS), MAX_PLAYERS)
    code = ''.join(secrets.choice(ALPHABET) for _ in range(8))
    while code in ROOMS:
        code = ''.join(secrets.choice(ALPHABET) for _ in range(8))
    ROOMS[code] = {'created': time.monotonic(), 'started': False, 'max': players,
                   'sockets': set(), 'players': {}, 'known': set()}
    return api(200, {'room': code, 'maxPlayers': players})


async def route(connection, request):
    url = urlsplit(request.path)
    path, parts = url.path, url.path.strip('/').split('/')
    if not path.startswith('/api/'):
        return await static(request, path)
    # Actions that change state need a custom header, which browsers will not send
    # cross-site without CORS permission and link prefetchers never send.
    trusted = request.headers.get(API_HEADER) == '1'
    if parts == ['api', 'newroom']:
        return new_room(parse_qs(url.query)) if trusted else api(403, {'error': 'Missing header'})
    if len(parts) >= 3 and parts[1] in ('room', 'ws') and is_room_code(parts[2]):
        room = room_for(parts[2])
        if not room:
            return api(404, {'error': 'Room not found or expired'})
        if parts[1] == 'room':
            if parts[3:] == ['start']:
                if not trusted:
                    return api(403, {'error': 'Missing header'})
                room['started'] = True
            elif parts[3:]:
                return api(404, {'error': 'Not found'})
            return api(200, room_status(parts[2], room))
        if request.headers.get('Upgrade', '').lower() != 'websocket':
            return api(400, {'error': 'WebSocket required'})
        if len(room['sockets']) >= room['max']:
            return api(409, {'error': 'Room is full'})
        if room['started'] and len(room['known']) <= len(room['players']):
            return api(409, {'error': 'Match already started'})
        connection.fragline_room = room
        return None
    return api(404, {'error': 'Invalid room'})


async def relay(connection):
    room = connection.fragline_room
    # Capacity is checked again here: the HTTP check above cannot reserve a slot,
    # because a handshake that fails afterwards would never release it.
    if len(room['sockets']) >= room['max']:
        await connection.close(1013, 'Room is full')
        return
    room['sockets'].add(connection)
    identity = None
    count, epoch = 0, time.monotonic()
    try:
        while True:
            try:
                packet = await asyncio.wait_for(connection.recv(), IDLE_TIMEOUT)
            except asyncio.TimeoutError:
                await connection.close(1001, 'Idle')
                break
            now = time.monotonic()
            if now - epoch > 1:
                count, epoch = 0, now
            count += 1
            if count > 500:
                await connection.close(1008, 'Message limit')
                break
            if not isinstance(packet, bytes) or not 8 <= len(packet) <= 65536:
                await connection.close(1003, 'Invalid packet')
                break
            destination, sender = struct.unpack_from('<II', packet)
            if identity is None:
                if room['players'].get(sender) not in (None, connection):
                    await connection.close(1008, 'Duplicate player')
                    break
                # After the match starts only players who were in it may come back.
                if room['started'] and sender not in room['known']:
                    await connection.close(1008, 'Match already started')
                    break
                identity = sender
                room['players'][sender] = connection
                room['known'].add(sender)
            elif identity != sender:
                await connection.close(1008, 'Invalid identity')
                break
            target = room['players'].get(destination)
            if target is not None:
                try:
                    await target.send(packet[4:])
                except ConnectionClosed:
                    pass  # The receiver left; its own handler cleans up.
    except ConnectionClosed:
        pass
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


def warm_cache():
    for path in PUBLIC.rglob('*'):
        if path.is_file():
            load_file(path)


async def main(port):
    print('Preparing game files...', flush=True)
    await asyncio.to_thread(warm_cache)
    async with serve(relay, '0.0.0.0', port, process_request=route,
                     compression=None, max_size=65536, ping_interval=20, close_timeout=2):
        print(f'Fragline local game: http://{lan_ip()}:{port}/', flush=True)
        print('Open this link on every laptop, then create/share a room. Keep this window open.', flush=True)
        print('If asked by Windows, allow Python on your private network. Press Ctrl+C to stop.', flush=True)
        await asyncio.Future()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    try:
        asyncio.run(main(parser.parse_args().port))
    except KeyboardInterrupt:
        pass
