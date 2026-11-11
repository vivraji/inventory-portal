"""API contracts against disposable storage; OpenAI is always mocked."""
import base64
import csv
import importlib.util
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

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
        self.env = patch.dict(self.module.os.environ, {'OPENAI_API_KEY': '', 'OPENAI_MODEL': 'test-model'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.ai = patch('openai.OpenAI')
        self.mock_ai = self.ai.start()
        self.addCleanup(self.ai.stop)

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
        self.assertEqual(response.json(), suggestion)
        self.assertEqual(self.client.get('/api/components').json(), [])
        self.assertEqual(list(self.module.UPLOADS.iterdir()), [])
        self.mock_ai.assert_called_once_with(api_key='fake-test-key', timeout=35)
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
        created = self.create(image=image)
        spec = importlib.util.spec_from_file_location('restarted_api', self.root / 'app.py')
        restarted = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(restarted)
        with TestClient(restarted.app) as client:
            self.assertEqual(client.get('/api/components').json(), [created])
            self.assertEqual(client.get(image).content, b'fixture')
