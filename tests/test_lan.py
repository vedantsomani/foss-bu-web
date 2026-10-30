"""Static file serving tests for lan_server.py (relay rules are in tests/relay.test.cjs)."""
import asyncio
import gzip
import sys
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lan_server as app  # noqa: E402
from websockets.asyncio.server import serve  # noqa: E402


class LanStatic(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        app.ROOMS.clear()
        self.server = await serve(app.relay, '127.0.0.1', 0, process_request=app.route,
                                  compression=None, max_size=65536, close_timeout=1)
        self.base = f'http://127.0.0.1:{self.server.sockets[0].getsockname()[1]}'

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()

    async def get(self, path, headers=None):
        def fetch():
            request = urllib.request.Request(self.base + path, headers=headers or {})
            try:
                with urllib.request.urlopen(request, timeout=10) as r:
                    return r.status, r.read(), r.headers
            except urllib.error.HTTPError as err:
                return err.code, err.read(), err.headers
        return await asyncio.to_thread(fetch)

    async def test_pages_and_game_files(self):
        status, page, headers = await self.get('/')
        self.assertEqual(status, 200)
        self.assertIn(b'game.js', page)
        self.assertIn('text/html', headers['Content-Type'])
        self.assertEqual((await self.get('/abcdefgh'))[1], page)
        for name in ['freedm.wad.gz', 'websockets-doom.wasm.gz', 'fragline.wad', 'manifest.webmanifest', 'game.js', 'sw.js']:
            status, body, _ = await self.get('/' + name)
            self.assertEqual(status, 200, name)
            self.assertEqual(body, (app.PUBLIC / name).read_bytes(), name)

    async def test_gzip_and_revalidation(self):
        status, body, headers = await self.get('/game.js', {'Accept-Encoding': 'gzip'})
        self.assertEqual(headers['Content-Encoding'], 'gzip')
        self.assertEqual(gzip.decompress(body), (app.PUBLIC / 'game.js').read_bytes())
        # Already-compressed downloads are sent as they are.
        _, _, headers = await self.get('/freedm.wad.gz', {'Accept-Encoding': 'gzip'})
        self.assertIsNone(headers['Content-Encoding'])
        etag = (await self.get('/game.js'))[2]['ETag']
        status, body, _ = await self.get('/game.js', {'If-None-Match': etag})
        self.assertEqual((status, body), (304, b''))

    async def test_missing_and_path_escape(self):
        for path in ['/api/room/abcdefgh', '/../lan_server.py', '/%2e%2e/lan_server.py', '/nope.txt']:
            self.assertEqual((await self.get(path))[0], 404, path)


if __name__ == '__main__':
    unittest.main()
