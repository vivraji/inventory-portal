"""API contracts against disposable storage; OpenAI is always mocked."""
import base64
import csv
import importlib.util
import io
import json
import shutil
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
LIMIT = 10 * 1024 * 1024


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        shutil.copy(ROOT / 'app.py', self.root)
        shutil.copytree(ROOT / 'static', self.root / 'static')
        spec = importlib.util.spec_from_file_location('isolated_api', self.root / 'app.py')
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.client = TestClient(self.module.app)
        self.addCleanup(self.client.close)
        # Never use a developer's real key, even if the environment provides one.
        self.env = patch.dict(self.module.os.environ, {'OPENAI_API_KEY': '', 'OPENAI_MODEL': 'test-model', 'ANTHROPIC_API_KEY': '', 'ANTHROPIC_MODEL': 'test-claude', 'ANTHROPIC_WORKSPACE_ID': ''})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.ai = patch('openai.OpenAI')
        self.mock_ai = self.ai.start()
        self.addCleanup(self.ai.stop)
        self.claude = patch('httpx.AsyncClient')
        self.mock_claude = self.claude.start()
        self.addCleanup(self.claude.stop)
        self.claude_post = AsyncMock(side_effect=AssertionError('Unconfigured Claude call'))
        self.mock_claude.return_value.__aenter__.return_value.post = self.claude_post

    def create(self, **fields):
        response = self.client.post('/api/components', json={'name': 'Test board', **fields})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def photo(self, path='/api/upload', content=b'fixture', kind='image/jpeg'):
        return self.client.post(path, files={'file': ('component.photo', content, kind)})

    def test_empty_inventory_and_export(self):
        self.assertEqual(self.client.get('/api/components').json(), [])
        self.assertEqual(self.client.get('/api/stats').json(),
                         {'types': 0, 'units': 0, 'low_stock': 0, 'categories': [], 'locations': []})
        response = self.client.get('/api/export.csv')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(list(csv.DictReader(io.StringIO(response.text))), [])
        self.assertIn('attachment;', response.headers['content-disposition'])

    def test_crud_defaults_full_replacement_and_missing_records(self):
        created = self.create(notes='original', quantity=3, location='A')
        self.assertEqual(created['category'], 'Other')
        self.assertEqual(created['min_quantity'], 0)
        self.assertEqual(created['image'], '')
        self.assertTrue(created['id'])
        self.assertEqual(created['created_at'], created['updated_at'])
        self.assertEqual(self.client.get('/api/components').json(), [created])
        path = '/api/components/' + created['id']
        response = self.client.put(path, json={'name': 'Replaced', 'quantity': 8})
        self.assertEqual(response.status_code, 200)
        updated = response.json()
        self.assertEqual(updated['id'], created['id'])
        self.assertEqual(updated['created_at'], created['created_at'])
        self.assertGreaterEqual(updated['updated_at'], created['updated_at'])
        self.assertEqual(updated['quantity'], 8)
        self.assertEqual(updated['notes'], '')  # PUT replaces omitted optional fields.
        self.assertEqual(updated['location'], '')
        self.assertEqual(self.client.delete(path).json(), {'deleted': created['id']})
        self.assertEqual(self.client.get('/api/components').json(), [])
        self.assertEqual(self.client.delete(path).status_code, 404)
        self.assertEqual(self.client.put(path, json={'name': 'Gone'}).status_code, 404)

    def test_invalid_records_are_rejected_without_mutating_inventory(self):
        existing = self.create()
        for fields in [{'name': ''}, {'name': 'x' * 181}, {'quantity': -1},
                       {'quantity': 1.5}, {'min_quantity': -1}, {'price': -0.01},
                       {'notes': 'x' * 5001}, {'category': 'x' * 81}]:
            with self.subTest(fields=list(fields)):
                body = {'name': 'Invalid', **fields}
                self.assertEqual(self.client.post('/api/components', json=body).status_code, 422)
                self.assertEqual(self.client.put('/api/components/' + existing['id'], json=body).status_code, 422)
        self.assertEqual(self.client.post('/api/components', json={}).status_code, 422)
        self.assertEqual(self.client.get('/api/components').json(), [existing])

    def test_search_all_fields_and_combine_filters(self):
        a = self.create(name='ESP board', manufacturer='Acme', model='M42', notes='wireless',
                        project='Weather', category='Boards', location='Bin A')
        b = self.create(name='Temperature sensor', category='Sensors', location='Bin B')
        for query in ['esp', 'ACME', 'M42', 'wireless', 'Weather']:
            with self.subTest(query=query):
                rows = self.client.get('/api/components', params={'q': query}).json()
                self.assertEqual([r['id'] for r in rows], [a['id']])
        for params, expected in [({'category': 'Sensors'}, [b['id']]),
                                 ({'location': 'Bin A'}, [a['id']]),
                                 ({'q': 'esp', 'category': 'Boards', 'location': 'Bin A'}, [a['id']]),
                                 ({'q': 'esp', 'category': 'Sensors'}, []),
                                 ({'q': "' OR 1=1 --"}, [])]:
            with self.subTest(params=params):
                self.assertEqual([r['id'] for r in self.client.get('/api/components', params=params).json()], expected)

    def test_stats_threshold_boundaries_and_distinct_filters(self):
        self.create(quantity=2, min_quantity=2, category='Boards', location='A')
        self.create(quantity=0, min_quantity=1, category='Boards', location='A')
        self.create(quantity=0, min_quantity=0, category='Sensors', location='')
        self.create(quantity=4, min_quantity=3, category='Sensors', location='B')
        self.assertEqual(self.client.get('/api/stats').json(),
                         {'types': 4, 'units': 6, 'low_stock': 2,
                          'categories': ['Boards', 'Sensors'], 'locations': ['A', 'B']})

    def test_upload_formats_size_boundary_and_retention(self):
        for kind, suffix in [('image/jpeg', '.jpg'), ('image/png', '.png'),
                             ('image/webp', '.webp'), ('image/heic', '.heic')]:
            with self.subTest(kind=kind):
                response = self.photo(kind=kind)
                self.assertEqual(response.status_code, 200)
                image = response.json()['image']
                self.assertTrue(image.endswith(suffix))
                created = self.create(image=image)
                self.assertEqual(self.client.get(image).content, b'fixture')
                self.client.delete('/api/components/' + created['id'])
                self.assertEqual(self.client.get(image).content, b'fixture')
        self.assertEqual(self.photo(content=b'x' * LIMIT).status_code, 200)
        before = set(self.module.UPLOADS.iterdir())
        self.assertEqual(self.photo(content=b'x' * (LIMIT + 1)).status_code, 413)
        self.assertEqual(self.photo(kind='text/html').status_code, 415)
        self.assertEqual(self.client.post('/api/upload').status_code, 422)
        self.assertEqual(set(self.module.UPLOADS.iterdir()), before)
        self.mock_ai.assert_not_called()

    def test_csv_preserves_text_numbers_identifiers_and_sort_order(self):
        a = self.create(name='Alpha, "board"', notes='line one\nline two', quantity=2, price=1.25)
        b = self.create(name='Zulu', image='/uploads/example.jpg')
        response = self.client.get('/api/export.csv')
        self.assertIn('text/csv', response.headers['content-type'])
        rows = list(csv.DictReader(io.StringIO(response.text)))
        self.assertEqual([r['id'] for r in rows], [a['id'], b['id']])
        for actual, expected in zip(rows, [a, b]):
            self.assertEqual(set(actual), set(expected))
            for key in expected:
                self.assertEqual(actual[key], str(expected[key]), key)

    def test_ai_missing_key_formats_and_size_limits(self):
        self.assertEqual(self.photo('/api/identify').status_code, 503)
        with patch.dict(self.module.os.environ, {'OPENAI_API_KEY': 'fake-test-key'}):
            self.assertEqual(self.photo('/api/identify', kind='image/heic').status_code, 415)
            self.assertEqual(self.photo('/api/identify', content=b'x' * (LIMIT + 1)).status_code, 413)
            self.assertEqual(self.client.post('/api/identify').status_code, 422)
        self.mock_ai.assert_not_called()

    def test_ai_suggestions_are_advisory_and_do_not_save_or_upload(self):
        suggestion = {'name': 'Possible board', 'category': 'Boards', 'manufacturer': '',
                      'model': '', 'notes': 'Check markings', 'confidence': 'low',
                      'uncertainty': 'Need a closer photograph'}
        self.mock_ai.return_value.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps(suggestion)))])
        with patch.dict(self.module.os.environ, {'OPENAI_API_KEY': 'fake-test-key'}):
            response = self.photo('/api/identify')
        self.assertEqual(response.status_code, 200)
        self.assertEqual({k: response.json()[k] for k in suggestion}, suggestion)
        self.assertEqual(response.json()['provider'], 'openai')
        self.assertEqual(response.json()['fallback_reason'], 'claude_not_configured')
        self.assertTrue(response.json()['diagnostic_id'])
        self.assertEqual(self.client.get('/api/components').json(), [])
        self.assertEqual(list(self.module.UPLOADS.iterdir()), [])
        self.mock_ai.assert_called_once_with(api_key='fake-test-key', timeout=35, max_retries=0)
        request = self.mock_ai.return_value.chat.completions.create.call_args.kwargs
        self.assertEqual(request['model'], 'test-model')
        image = request['messages'][1]['content'][1]['image_url']['url']
        self.assertEqual(image, 'data:image/jpeg;base64,' + base64.b64encode(b'fixture').decode())

    def test_ai_upstream_failure_and_malformed_json_are_safe_errors(self):
        for malformed in [False, True]:
            with self.subTest(malformed=malformed):
                call = self.mock_ai.return_value.chat.completions.create
                call.side_effect = None if malformed else RuntimeError('private upstream detail')
                call.return_value = SimpleNamespace(choices=[SimpleNamespace(
                    message=SimpleNamespace(content='not JSON'))])
                with patch.dict(self.module.os.environ, {'OPENAI_API_KEY': 'fake-test-key'}):
                    response = self.photo('/api/identify')
                self.assertEqual(response.status_code, 502)
                self.assertNotIn('private upstream detail', response.text)
                self.assertNotIn('fake-test-key', response.text)
        self.assertEqual(self.client.get('/api/components').json(), [])

    def test_reimport_preserves_database_and_photograph(self):
        image = self.photo().json()['image']
        back = self.photo(content=b'back').json()['image']
        created = self.create(image=image, image_back=back)
        spec = importlib.util.spec_from_file_location('restarted_api', self.root / 'app.py')
        restarted = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(restarted)
        with TestClient(restarted.app) as client:
            self.assertEqual(client.get('/api/components').json(), [created])
            self.assertEqual(client.get(image).content, b'fixture')
            self.assertEqual(client.get(back).content, b'back')

    def test_two_catalog_slots_survive_edits_export_and_restart(self):
        front = self.photo(content=b'front').json()['image']
        back = self.photo(content=b'back').json()['image']
        created = self.create(image=front, image_back=back)
        self.assertEqual(created['image_back'], back)
        path = '/api/components/' + created['id']
        # An older client must not erase a back photo it cannot display.
        updated = self.client.put(path, json={'name': 'Old client edit', 'image': front}).json()
        self.assertEqual(updated['image_back'], back)
        rows = list(csv.DictReader(io.StringIO(self.client.get('/api/export.csv').text)))
        self.assertEqual(rows[0]['image_back'], back)
        cleared = self.client.put(path, json={'name': 'Clear back', 'image': front, 'image_back': ''}).json()
        self.assertEqual(cleared['image_back'], '')
        self.assertEqual(self.client.get(back).content, b'back')
        self.assertEqual(self.client.get(front).content, b'front')

    def test_multiple_ai_photos_sent_together_without_persistence(self):
        self.mock_ai.return_value.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"name":"Board"}'))])
        photos = [('files', ('front.jpg', b'front', 'image/jpeg')),
                  ('files', ('back.png', b'back', 'image/png')),
                  ('files', ('markings.webp', b'markings', 'image/webp'))]
        with patch.dict(self.module.os.environ, {'OPENAI_API_KEY': 'fake-test-key'}):
            response = self.client.post('/api/identify', files=photos)
        self.assertEqual(response.status_code, 200)
        request = self.mock_ai.return_value.chat.completions.create.call_args.kwargs
        parts = request['messages'][1]['content']
        self.assertEqual(len(parts), 4)
        for part, (_, (_, content, kind)) in zip(parts[1:], photos):
            self.assertEqual(part['image_url']['url'],
                             f'data:{kind};base64,{base64.b64encode(content).decode()}')
        self.assertEqual(list(self.module.UPLOADS.iterdir()), [])
        self.assertEqual(self.client.get('/api/components').json(), [])

    def test_ai_validates_all_photos_count_and_total_before_calling_openai(self):
        cases = [([('files', ('x.jpg', b'x', 'image/jpeg'))] * 7, 422),
                 ([('files', ('x.jpg', b'x', 'image/jpeg')),
                   ('files', ('bad.heic', b'x', 'image/heic'))], 415),
                 ([('files', ('empty.jpg', b'', 'image/jpeg'))], 422),
                 ([('files', ('large.jpg', b'x' * (LIMIT + 1), 'image/jpeg'))], 413),
                 ([('files', ('large.jpg', b'x' * LIMIT, 'image/jpeg'))] * 3, 413)]
        with patch.dict(self.module.os.environ, {'OPENAI_API_KEY': 'fake-test-key'}):
            for photos, status in cases:
                with self.subTest(status=status, count=len(photos)):
                    self.assertEqual(self.client.post('/api/identify', files=photos).status_code, status)
        self.mock_ai.assert_not_called()
        self.assertEqual(list(self.module.UPLOADS.iterdir()), [])

    def test_legacy_database_migration_is_additive_and_repeatable(self):
        legacy_root = self.root / 'legacy'
        legacy_root.mkdir()
        shutil.copy(self.root / 'app.py', legacy_root)
        shutil.copytree(self.root / 'static', legacy_root / 'static')
        (legacy_root / 'data/uploads').mkdir(parents=True)
        photo = legacy_root / 'data/uploads/existing.jpg'
        photo.write_bytes(b'original photo')
        original = self.create(image='/uploads/existing.jpg', quantity=7)
        original.pop('image_back')
        with closing(sqlite3.connect(self.module.DB)) as con:
            columns = [r for r in con.execute('PRAGMA table_info(components)') if r[1] != 'image_back']
        with closing(sqlite3.connect(legacy_root / 'data/inventory.db')) as con:
            declarations = [f'{r[1]} {r[2]}' + (' PRIMARY KEY' if r[5] else '') +
                            (' NOT NULL' if r[3] else '') + (f' DEFAULT {r[4]}' if r[4] is not None else '')
                            for r in columns]
            con.execute('CREATE TABLE components (' + ','.join(declarations) + ')')
            con.execute('INSERT INTO components (' + ','.join(original) + ') VALUES (' +
                        ','.join('?' for _ in original) + ')', list(original.values()))
            con.commit()
        for _ in range(2):
            spec = importlib.util.spec_from_file_location('legacy_api', legacy_root / 'app.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            with TestClient(module.app) as client:
                self.assertEqual(client.get('/api/components').json(), [{**original, 'image_back': ''}])
            self.assertEqual(photo.read_bytes(), b'original photo')

    def mock_claude_response(self, text, status=200):
        self.claude_post.side_effect = None
        self.claude_post.return_value = httpx.Response(status,
            json={'content': [{'type': 'text', 'text': text}]},
            request=httpx.Request('POST', 'https://api.anthropic.com/v1/messages'))

    def test_claude_is_primary_and_receives_all_photos(self):
        self.mock_claude_response('{"name":"Board","confidence":"low"}')
        photos = [('files', ('front.jpg', b'front', 'image/jpeg')),
                  ('files', ('back.png', b'back', 'image/png'))]
        with patch.dict(self.module.os.environ, {'ANTHROPIC_API_KEY': 'fake-claude',
                        'OPENAI_API_KEY': 'fake-openai', 'ANTHROPIC_WORKSPACE_ID': 'test-workspace'}):
            response = self.client.post('/api/identify', files=photos)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['provider'], 'claude')
        # Low confidence is shown for review, without a second paid request.
        self.mock_ai.assert_not_called()
        request = self.claude_post.call_args.kwargs
        self.assertEqual(request['json']['model'], 'test-claude')
        self.assertEqual(request['headers']['Authorization'], 'Bearer fake-claude')
        self.assertEqual(request['headers']['anthropic-workspace-id'], 'test-workspace')
        blocks = request['json']['messages'][0]['content']
        self.assertEqual(len(blocks), 3)
        self.assertEqual(blocks[0]['source']['data'], base64.b64encode(b'front').decode())
        self.assertEqual(blocks[1]['source']['media_type'], 'image/png')
        self.assertEqual(list(self.module.UPLOADS.iterdir()), [])

    def test_openai_backup_on_claude_failure_or_unusable_response(self):
        self.mock_ai.return_value.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"name":"Backup board"}'))])
        for text, status in [('upstream error', 429), ('not JSON', 200), ('[]', 200),
                             ('{"name":3}', 200), ('{"name":"Board","notes":[]}', 200)]:
            with self.subTest(text=text, status=status):
                self.mock_claude_response(text, status)
                with patch.dict(self.module.os.environ, {'ANTHROPIC_API_KEY': 'fake-claude',
                                                       'OPENAI_API_KEY': 'fake-openai'}):
                    response = self.photo('/api/identify')
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()['provider'], 'openai')
                self.assertEqual(response.json()['fallback_reason'], 'claude_unavailable')
        self.assertEqual(self.mock_ai.call_count, 5)

    def test_claude_timeout_uses_backup_and_missing_backup_is_clear(self):
        self.claude_post.side_effect = httpx.ReadTimeout('private request details')
        self.mock_ai.return_value.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"name":"Backup"}'))])
        with patch.dict(self.module.os.environ, {'ANTHROPIC_API_KEY': 'fake-claude', 'OPENAI_API_KEY': 'fake-openai'}):
            response = self.photo('/api/identify')
        self.assertEqual(response.json()['provider'], 'openai')
        with patch.dict(self.module.os.environ, {'ANTHROPIC_API_KEY': 'fake-claude'}):
            response = self.photo('/api/identify')
        self.assertEqual(response.status_code, 502)
        self.assertIn('backup is not configured', response.text)
        self.assertNotIn('private request details', response.text)
        self.assertNotIn('fake-claude', response.text)

    def test_diagnostics_capture_claude_failure_and_openai_response_in_order(self):
        self.mock_claude_response('Claude could not process this image', status=400)
        self.mock_ai.return_value.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"name":"Backup board"}'))])
        with patch.dict(self.module.os.environ, {'ANTHROPIC_API_KEY': 'fake-claude', 'OPENAI_API_KEY': 'fake-openai'}):
            response = self.photo('/api/identify', content=b'private image fixture')
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result['fallback_detail'], 'Claude HTTP 400')
        path = self.root / 'data/logs/ai-identification.jsonl'
        records = [json.loads(line) for line in path.read_text().splitlines()]
        self.assertTrue(all(record['request_id'] == result['diagnostic_id'] for record in records))
        self.assertEqual([(r['provider'], r['event']) for r in records], [
            ('claude','started'), ('claude','response'), ('claude','failed'),
            ('openai','started'), ('openai','response'), ('openai','selected')])
        self.assertEqual(records[1]['http_status'], 400)
        self.assertIn('could not process', records[1]['response'])
        self.assertEqual(records[2]['reason'], 'Claude HTTP 400')
        self.assertEqual(records[4]['response'], '{"name":"Backup board"}')
        self.assertNotIn('fake-claude', path.read_text())
        self.assertNotIn('private image fixture', path.read_text())
        self.assertNotIn(base64.b64encode(b'private image fixture').decode(), path.read_text())
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        # Diagnostics are not served by the public upload or static mounts.
        self.assertEqual(self.client.get('/data/logs/ai-identification.jsonl').status_code, 404)

    def test_diagnostics_capture_invalid_json_and_success_without_backup(self):
        self.mock_claude_response('not JSON')
        with patch.dict(self.module.os.environ, {'ANTHROPIC_API_KEY': 'fake-claude'}):
            self.assertEqual(self.photo('/api/identify').status_code, 502)
        self.mock_claude_response('{"name":"Claude board"}')
        with patch.dict(self.module.os.environ, {'ANTHROPIC_API_KEY': 'fake-claude'}):
            result = self.photo('/api/identify').json()
        records = [json.loads(line) for line in (self.root/'data/logs/ai-identification.jsonl').read_text().splitlines()]
        self.assertTrue(any(r.get('reason') == 'Claude returned invalid JSON' for r in records))
        selected = [r for r in records if r['request_id'] == result['diagnostic_id']]
        self.assertEqual([r['event'] for r in selected], ['started', 'response', 'selected'])
        self.assertTrue(all(r['provider'] == 'claude' for r in selected))
        self.mock_ai.assert_not_called()

    def test_diagnostics_redact_echoed_keys_and_images_and_bound_output(self):
        secret = 'fake-private-key'
        image = base64.b64encode(b'private fixture').decode()
        with patch.dict(self.module.os.environ, {'ANTHROPIC_API_KEY': secret}):
            self.module.log_ai_event('request', 'claude', 'response', redactions=[image],
                                     response=f'{secret} data:image/jpeg;base64,{image}')
            self.module.log_ai_event('request', 'claude', 'response', response='word ' * 20000)
        path = self.root / 'data/logs/ai-identification.jsonl'
        text = path.read_text()
        self.assertNotIn(secret, text)
        self.assertNotIn(image, text)
        self.assertIn('[REDACTED', text)
        self.assertIn('[TRUNCATED]', text)
        self.assertLessEqual(len(json.loads(text.splitlines()[1])['response']), 65536 + 12)

    def test_diagnostics_rotate_and_io_failure_does_not_discard_identification(self):
        for _ in range(34):
            self.module.log_ai_event('request', 'claude', 'response', response='word ' * 13000)
        directory = self.root / 'data/logs'
        self.assertTrue((directory/'ai-identification.jsonl.1').exists())
        self.assertLessEqual(len(list(directory.iterdir())), 4)
        self.mock_claude_response('{"name":"Still identified"}')
        with patch.object(self.module, 'PrivateAIHandler', side_effect=OSError('disk unavailable')):
            with patch.dict(self.module.os.environ, {'ANTHROPIC_API_KEY': 'fake-claude'}):
                result = self.photo('/api/identify')
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()['provider'], 'claude')
        self.mock_ai.assert_not_called()

    def test_diagnostics_record_openai_http_error_without_exposing_keys(self):
        upstream = httpx.Response(429, json={'error': {'message': 'Rate limit fake-openai'}},
                                  request=httpx.Request('POST', 'https://api.openai.com/v1/chat/completions'))
        self.mock_ai.return_value.chat.completions.create.side_effect = httpx.HTTPStatusError(
            'upstream error', request=upstream.request, response=upstream)
        with patch.dict(self.module.os.environ, {'OPENAI_API_KEY': 'fake-openai'}):
            response = self.photo('/api/identify')
        self.assertEqual(response.status_code, 502)
        records = [json.loads(line) for line in (self.root/'data/logs/ai-identification.jsonl').read_text().splitlines()]
        error = next(r for r in records if r['provider'] == 'openai' and r['event'] == 'response')
        self.assertEqual(error['http_status'], 429)
        self.assertIn('Rate limit', error['response'])
        self.assertNotIn('fake-openai', error['response'])
        self.assertNotIn('fake-openai', response.text)

    def test_ai_long_labels_return_saveable_metadata_without_losing_original_text(self):
        original = {'name': 'N' * 201, 'category': 'C' * 90,
                    'manufacturer': 'M' * 130, 'model': 'Part number ' * 20,
                    'notes': 'Visible markings', 'confidence': 'high', 'uncertainty': ''}
        self.mock_claude_response(json.dumps(original))
        with patch.dict(self.module.os.environ, {'ANTHROPIC_API_KEY': 'fake-claude'}):
            response = self.photo('/api/identify')
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result['provider'], 'claude')
        self.assertTrue(result['metadata_warnings'])
        for field, maximum in [('name',180), ('category',80), ('manufacturer',120), ('model',120)]:
            self.assertLessEqual(len(result[field]), maximum)
            self.assertIn(original[field].strip(), result['notes'])
        # Exercise the actual save endpoint using the returned descriptive fields.
        saved = self.client.post('/api/components', json={key: result[key] for key in self.module.IDENTIFICATION_FIELDS})
        self.assertEqual(saved.status_code, 201, saved.text)
        self.mock_ai.assert_not_called()

    def test_ai_response_fills_unknown_fields_but_never_infers_inventory_quantities(self):
        result = self.module.identification_result('{"name":"Board","quantity":99,"location":"invented"}', 'claude', '')
        for field in ['category','manufacturer','model','notes','uncertainty']:
            self.assertEqual(result[field], '')
        self.assertEqual(result['confidence'], 'unknown')
        self.assertNotIn('quantity', result)
        self.assertNotIn('location', result)
        for response in [{'name':'Board','notes':'n' * 5001}, {'name':'Board','confidence':'certain'},
                         {'name':'Board','uncertainty':'u' * 2001}]:
            with self.subTest(fields=list(response)):
                with self.assertRaises(ValueError):
                    self.module.identification_result(json.dumps(response), 'claude', '')

    def test_both_providers_receive_the_same_complete_structured_schema(self):
        self.mock_claude_response('invalid JSON')
        self.mock_ai.return_value.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"name":"Board"}'))])
        with patch.dict(self.module.os.environ, {'ANTHROPIC_API_KEY':'fake-claude', 'OPENAI_API_KEY':'fake-openai'}):
            self.assertEqual(self.photo('/api/identify').status_code, 200)
        claude = self.claude_post.call_args.kwargs['json']['output_config']['format']
        openai = self.mock_ai.return_value.chat.completions.create.call_args.kwargs['response_format']
        self.assertEqual(claude['type'], 'json_schema')
        self.assertEqual(openai['type'], 'json_schema')
        self.assertTrue(openai['json_schema']['strict'])
        self.assertEqual(claude['schema'], openai['json_schema']['schema'])
        schema = claude['schema']
        self.assertEqual(set(schema['required']), set(schema['properties']))
        self.assertFalse(schema['additionalProperties'])
        for field in self.module.IDENTIFICATION_FIELDS:
            maximum = self.module.Component.model_json_schema()['properties'][field]['maxLength']
            self.assertIn(str(maximum), schema['properties'][field]['description'])
