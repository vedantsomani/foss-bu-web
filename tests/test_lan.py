import asyncio
import json
import struct
import unittest
import urllib.request
import urllib.error
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lan_server as app
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed, InvalidStatus

class LanFlow(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        app.ROOMS.clear()
        self.server = await serve(app.relay, '127.0.0.1', 0, process_request=app.route, compression=None, max_size=65536, close_timeout=1)
        self.port = self.server.sockets[0].getsockname()[1]
        self.base = f'http://127.0.0.1:{self.port}'
    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()
    async def get(self, path):
        def fetch():
            with urllib.request.urlopen(self.base + path, timeout=5) as r:
                return r.read(), r.headers.get('Content-Type', '')
        return await asyncio.to_thread(fetch)
    async def test_complete_room_flow(self):
        data, _ = await self.get('/api/newroom')
        code = json.loads(data)['room']
        page, _ = await self.get('/' + code)
        self.assertIn(b'controller.js', page)
        for name in ['freedm.wad','fossbu.wad','websockets-doom.wasm','smooth.cfg','vendor/clipboard.min.js','vendor/nipplejs.js']:
            body, kind = await self.get('/' + name)
            self.assertEqual(body, (app.PUBLIC / name).read_bytes())
            if name.endswith('.wasm'): self.assertEqual(kind, 'application/wasm')
        url = f'ws://127.0.0.1:{self.port}/api/ws/{code}'
        async with connect(url, compression=None) as host, connect(url, compression=None) as guest:
            await host.send(struct.pack('<II',0,1))
            await guest.send(struct.pack('<II',1,2)+b'guest')
            self.assertEqual(await asyncio.wait_for(host.recv(),2), struct.pack('<I',2)+b'guest')
            await host.send(struct.pack('<II',2,1)+b'host')
            self.assertEqual(await asyncio.wait_for(guest.recv(),2), struct.pack('<I',1)+b'host')
            with self.assertRaises(InvalidStatus) as err:
                async with connect(url): pass
            self.assertEqual(err.exception.response.status_code,409)
            await guest.send('bad packet')
            with self.assertRaises(ConnectionClosed) as err: await guest.recv()
            self.assertEqual(err.exception.rcvd.code,1003)
            await self.get('/api/room/'+code+'/started')
            with self.assertRaises(InvalidStatus):
                async with connect(url): pass
    async def test_missing_and_path_escape(self):
        for path in ['/api/room/abcdefgh','/../lan_server.py','/%2e%2e/lan_server.py']:
            with self.assertRaises(urllib.error.HTTPError) as err: await self.get(path)
            self.assertEqual(err.exception.code,404)

if __name__ == '__main__': unittest.main()
