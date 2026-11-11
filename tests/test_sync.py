"""Real HTTP/SSE regression tests; only a temporary project copy is imported."""
import asyncio
import importlib.util
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]


class SyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        shutil.copy(ROOT / 'app.py', cls.root)
        shutil.copytree(ROOT / 'static', cls.root / 'static')
        sock = socket.socket()
        sock.bind(('127.0.0.1', 0))
        cls.url = f'http://127.0.0.1:{sock.getsockname()[1]}'
        cls.server = subprocess.Popen(
            [sys.executable, '-m', 'uvicorn', 'app:app', '--fd', str(sock.fileno()),
             '--log-level', 'error'], cwd=cls.root, pass_fds=(sock.fileno(),))
        sock.close()
        cls.client = httpx.Client(base_url=cls.url, timeout=3, trust_env=False)
        for _ in range(100):
            try:
                if cls.client.get('/api/stats').status_code == 200:
                    return
            except httpx.TransportError:
                time.sleep(.05)
        cls.tearDownClass()
        raise RuntimeError('Isolated test server did not start')

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        cls.server.terminate()
        cls.server.wait(timeout=10)
        cls.temp.cleanup()

    def test_two_clients_crud_and_reconnect(self):
        with self.client.stream('GET', '/api/events') as a, self.client.stream('GET', '/api/events') as b:
            self.assertIn('text/event-stream', a.headers['content-type'])
            self.assertEqual(a.headers['cache-control'], 'no-cache')
            streams = [a.iter_lines(), b.iter_lines()]
            for lines in streams:
                self.assertEqual(next(lines), 'retry: 3000')
                self.assert_event(lines)
            response = self.client.post('/api/components', json={'name': 'SSE board', 'quantity': 2})
            self.assertEqual(response.status_code, 201)
            ident = response.json()['id']
            for lines in streams:
                self.assert_event(lines)
            self.assertEqual(self.client.get('/api/components', params={'q': 'SSE board'}).json()[0]['quantity'], 2)
            self.assertEqual(self.client.put(f'/api/components/{ident}', json={'name': 'SSE board', 'quantity': 4}).status_code, 200)
            for lines in streams:
                self.assert_event(lines)
            self.assertEqual(self.client.delete(f'/api/components/{ident}').status_code, 200)
            for lines in streams:
                self.assert_event(lines)
            self.assertEqual(self.client.get('/api/components', params={'q': 'SSE board'}).json(), [])
        # A mutation while disconnected is recovered by the initial invalidation.
        created = self.client.post('/api/components', json={'name': 'Missed change'}).json()
        with self.client.stream('GET', '/api/events', headers={'Last-Event-ID': 'obsolete'}) as response:
            lines = response.iter_lines()
            next(lines)
            self.assert_event(lines)
            self.assertTrue(any(c['id'] == created['id'] for c in self.client.get('/api/components').json()))

    def assert_event(self, lines):
        for line in lines:
            if line:
                self.assertEqual(line, 'event: inventory')
                self.assertEqual(next(lines), 'data: {}')
                self.assertEqual(next(lines), '')
                return
        self.fail('Stream ended without inventory event')

    def test_validation_and_missing_records(self):
        self.assertEqual(self.client.post('/api/components', json={'name': 'bad', 'quantity': -1}).status_code, 422)
        self.assertEqual(self.client.put('/api/components/missing', json={'name': 'missing'}).status_code, 404)
        self.assertEqual(self.client.delete('/api/components/missing').status_code, 404)

    def test_photo_is_retained_after_delete(self):
        photo = b'temporary upload fixture'
        uploaded = self.client.post('/api/upload', files={'file': ('test.jpg', photo, 'image/jpeg')})
        self.assertEqual(uploaded.status_code, 200)
        image = uploaded.json()['image']
        created = self.client.post('/api/components', json={'name': 'Photo test', 'image': image}).json()
        self.client.delete('/api/components/' + created['id'])
        self.assertEqual(self.client.get(image).content, photo)

    def test_commit_failure_does_not_publish_and_stream_cleans_up(self):
        # Import a second isolated instance for deterministic commit and cleanup assertions.
        spec = importlib.util.spec_from_file_location('isolated_inventory', self.root / 'app.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        async def check():
            class Connected:
                async def is_disconnected(self):
                    return False
            stream = module.events.stream(Connected())
            await anext(stream)
            self.assertEqual(len(module.events.clients), 1)
            queue = next(iter(module.events.clients))[1]
            con = sqlite3.connect(module.DB)
            con.execute("CREATE TRIGGER reject_test BEFORE INSERT ON components BEGIN SELECT RAISE(ABORT, 'test failure'); END")
            con.commit()
            try:
                with self.assertRaises(sqlite3.IntegrityError):
                    module.create_component(module.Component(name='Rejected'))
                await asyncio.sleep(0)
                self.assertTrue(queue.empty())
            finally:
                con.execute('DROP TRIGGER reject_test')
                con.commit()
                con.close()
                await stream.aclose()
            self.assertEqual(len(module.events.clients), 0)
            # Cancellation also releases subscriptions waiting for a mutation.
            stream = module.events.stream(Connected())
            await anext(stream)
            pending = asyncio.create_task(anext(stream))
            await asyncio.sleep(0)
            pending.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await pending
            self.assertEqual(len(module.events.clients), 0)
        asyncio.run(check())


if __name__ == '__main__':
    unittest.main()
