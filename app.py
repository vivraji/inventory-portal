import asyncio
import base64
import csv
import io
import json
import logging
import os
import re
import sqlite3
import time
import uuid
from logging.handlers import RotatingFileHandler

import httpx
from threading import Lock
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'data'
UPLOADS = DATA / 'uploads'
DATA.mkdir(exist_ok=True)
UPLOADS.mkdir(exist_ok=True)
DB = DATA / 'inventory.db'
app = FastAPI(title='Inventory Portal', docs_url='/api/docs')
app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')
app.mount('/uploads', StaticFiles(directory=UPLOADS), name='uploads')

AI_LOG_LOCK = Lock()

class PrivateAIHandler(RotatingFileHandler):
    def _open(self):
        descriptor = os.open(self.baseFilename, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        return os.fdopen(descriptor, self.mode, encoding=self.encoding)

def log_ai_event(request_id, provider, event, redactions=(), **details):
    """Local, bounded response diagnostics; never log request bodies or headers."""
    record = {'time': datetime.now(timezone.utc).isoformat(), 'request_id': request_id,
              'provider': provider, 'event': event, **details}
    payload = json.dumps(record, ensure_ascii=False, default=str)
    for name in ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']:
        secret = os.environ.get(name, '').strip()
        if secret:
            payload = payload.replace(secret, '[REDACTED KEY]')
    for value in redactions:
        if value:
            payload = payload.replace(value, '[REDACTED IMAGE]')
    payload = re.sub(r'data:image/[^,\s"\\]+[,;][A-Za-z0-9+/=]+', '[REDACTED IMAGE]', payload)
    payload = re.sub(r'[A-Za-z0-9+/]{120,}={0,2}', '[REDACTED LONG DATA]', payload)
    clean = json.loads(payload)
    for field, value in clean.items():
        if isinstance(value, str) and len(value) > 65536:
            clean[field] = value[:65536] + ' [TRUNCATED]'
    payload = json.dumps(clean, ensure_ascii=False)
    try:
        with AI_LOG_LOCK:
            directory = DATA / 'logs'
            directory.mkdir(mode=0o700, exist_ok=True)
            handler = PrivateAIHandler(directory / 'ai-identification.jsonl',
                                       maxBytes=2 * 1024 * 1024, backupCount=3, encoding='utf8')
            try:
                handler.emit(logging.LogRecord('inventory.ai', logging.INFO, '', 0, payload, (), None))
            finally:
                handler.close()
    except OSError:
        logging.getLogger('uvicorn.error').warning('AI diagnostics could not be written; request %s', request_id)

def ai_failure_reason(error):
    if isinstance(error, httpx.HTTPStatusError):
        return f'Claude HTTP {error.response.status_code}'
    if isinstance(error, httpx.TimeoutException):
        return 'Claude request timed out'
    if isinstance(error, json.JSONDecodeError):
        return 'Claude returned invalid JSON'
    if isinstance(error, (ValueError, KeyError, TypeError)):
        return 'Claude returned an unusable response'
    return 'Claude request failed'

# One Uvicorn process owns these transient invalidations. SQLite remains authoritative.
class InventoryEvents:
    def __init__(self):
        self.lock = Lock()
        self.clients = set()

    @staticmethod
    def wake(queue):
        if queue.empty():
            queue.put_nowait(True)

    def publish(self):
        with self.lock:
            for loop, queue in self.clients:
                loop.call_soon_threadsafe(self.wake, queue)

    async def stream(self, request):
        queue = asyncio.Queue(maxsize=1)
        client = (asyncio.get_running_loop(), queue)
        with self.lock:
            self.clients.add(client)
        try:
            # Always invalidate on connect: no event history is needed after a gap.
            yield 'retry: 3000\nevent: inventory\ndata: {}\n\n'
            while not await request.is_disconnected():
                try:
                    await asyncio.wait_for(queue.get(), timeout=15)
                    yield 'event: inventory\ndata: {}\n\n'
                except asyncio.TimeoutError:
                    yield ': keepalive\n\n'
        finally:
            with self.lock:
                self.clients.discard(client)

events = InventoryEvents()

@app.get('/api/events')
async def inventory_events(request: Request):
    return StreamingResponse(events.stream(request), media_type='text/event-stream',
                             headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

@contextmanager
def db():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA foreign_keys=ON')
    try:
        yield con
        con.commit()
    finally:
        con.close()

with db() as con:
    con.executescript('''
    CREATE TABLE IF NOT EXISTS components (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Other',
      manufacturer TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
      quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity >= 0),
      min_quantity INTEGER NOT NULL DEFAULT 1 CHECK(min_quantity >= 0),
      location TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '',
      vendor TEXT NOT NULL DEFAULT '', price REAL NOT NULL DEFAULT 0,
      datasheet TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
      image TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    ''')
    # Additive, repeatable migration: existing image references and records survive.
    if 'image_back' not in {row['name'] for row in con.execute('PRAGMA table_info(components)')}:
        con.execute("ALTER TABLE components ADD COLUMN image_back TEXT NOT NULL DEFAULT ''")

class Component(BaseModel):
    name: str = Field(min_length=1, max_length=180)
    category: str = Field(default='Other', max_length=80)
    manufacturer: str = Field(default='', max_length=120)
    model: str = Field(default='', max_length=120)
    quantity: int = Field(default=1, ge=0)
    min_quantity: int = Field(default=1, ge=0)
    location: str = Field(default='', max_length=120)
    project: str = Field(default='', max_length=120)
    vendor: str = Field(default='', max_length=120)
    price: float = Field(default=0, ge=0)
    datasheet: str = Field(default='', max_length=1000)
    notes: str = Field(default='', max_length=5000)
    image: str = Field(default='', max_length=300)
    image_back: str = Field(default='', max_length=300)

FIELDS = list(Component.model_fields)
IDENTIFICATION_FIELDS = ['name', 'category', 'manufacturer', 'model', 'notes']
METADATA_PROPERTIES = {key: value for key, value in Component.model_json_schema()['properties'].items()
                       if key in IDENTIFICATION_FIELDS}

def identification_schema():
    # Use the portable schema subset supported by both providers. Length constraints
    # remain authoritative in Component; include them as instructions and validate locally.
    properties = {}
    for key, field in METADATA_PROPERTIES.items():
        properties[key] = {'type': 'string', 'description':
            f"Maximum {field['maxLength']} characters. " +
            ('Use a concise generic name if uncertain.' if key == 'name' else 'Use an empty string if unknown.')}
    properties['confidence'] = {'type': 'string', 'enum': ['high', 'medium', 'low', 'unknown']}
    properties['uncertainty'] = {'type': 'string', 'description': 'Explain uncertainty or missing evidence, at most 2000 characters.'}
    return {'type': 'object', 'properties': properties,
            'required': list(properties), 'additionalProperties': False}

def now():
    return datetime.now(timezone.utc).isoformat()

def get_component(con, ident):
    row = con.execute('SELECT * FROM components WHERE id=?', (ident,)).fetchone()
    if not row:
        raise HTTPException(404, 'Component not found')
    return dict(row)

@app.get('/')
def home():
    return FileResponse(ROOT / 'static' / 'index.html')

@app.get('/api/components')
def list_components(q: str = '', category: str = '', location: str = ''):
    query = 'SELECT * FROM components WHERE 1=1'
    args = []
    if q:
        query += " AND (name LIKE ? OR model LIKE ? OR manufacturer LIKE ? OR notes LIKE ? OR project LIKE ?)"
        args.extend([f'%{q}%'] * 5)
    if category:
        query += ' AND category=?'
        args.append(category)
    if location:
        query += ' AND location=?'
        args.append(location)
    query += ' ORDER BY updated_at DESC'
    with db() as con:
        return [dict(x) for x in con.execute(query, args).fetchall()]

@app.get('/api/stats')
def stats():
    with db() as con:
        rows = con.execute('SELECT category,location,quantity,min_quantity FROM components').fetchall()
    return {
        'types': len(rows), 'units': sum(x['quantity'] for x in rows),
        'low_stock': sum(x['quantity'] <= x['min_quantity'] for x in rows if x['min_quantity'] > 0),
        'categories': sorted(set(x['category'] for x in rows)),
        'locations': sorted(set(x['location'] for x in rows if x['location']))
    }

@app.post('/api/components', status_code=201)
def create_component(component: Component):
    ident = str(uuid.uuid4())
    stamp = now()
    values = component.model_dump()
    with db() as con:
        con.execute('INSERT INTO components (' + ','.join(['id']+FIELDS+['created_at','updated_at']) + ') VALUES (' + ','.join('?' for _ in range(len(FIELDS)+3)) + ')', [ident] + [values[k] for k in FIELDS] + [stamp,stamp])
        result = get_component(con, ident)
    events.publish()
    return result

@app.put('/api/components/{ident}')
def update_component(ident: str, component: Component):
    values = component.model_dump()
    with db() as con:
        old = get_component(con, ident)
        # Preserve stored photo and threshold settings when older clients omit them.
        for field in ['image_back', 'min_quantity']:
            if field not in component.model_fields_set:
                values[field] = old[field]
        con.execute('UPDATE components SET ' + ','.join(f'{k}=?' for k in FIELDS) + ',updated_at=? WHERE id=?', [values[k] for k in FIELDS] + [now(),ident])
        result = get_component(con, ident)
    events.publish()
    return result

@app.delete('/api/components/{ident}')
def delete_component(ident: str):
    with db() as con:
        old = get_component(con, ident)
        con.execute('DELETE FROM components WHERE id=?', (ident,))
    # Retain uploaded photos to avoid accidental data loss on delete.
    events.publish()
    return {'deleted': old['id']}

@app.post('/api/upload')
async def upload(file: UploadFile = File(...)):
    allowed = {'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/heic':'.heic'}
    if file.content_type not in allowed:
        raise HTTPException(415, 'Upload a JPG, PNG, WebP, or HEIC photo')
    contents = await file.read(10 * 1024 * 1024 + 1)
    if len(contents) > 10 * 1024 * 1024:
        raise HTTPException(413, 'Maximum photo size is 10 MB')
    name = uuid.uuid4().hex + allowed[file.content_type]
    (UPLOADS / name).write_bytes(contents)
    return {'image': '/uploads/' + name}

@app.post('/api/identify')
async def identify(file: UploadFile | None = File(default=None),
                   files: list[UploadFile] | None = File(default=None)):
    key = os.environ.get('OPENAI_API_KEY', '').strip()
    claude_key = os.environ.get('ANTHROPIC_API_KEY', '').strip()
    if not key and not claude_key:
        raise HTTPException(503, 'Configure ANTHROPIC_API_KEY for Claude and OPENAI_API_KEY for backup')
    photos = ([file] if file else []) + (files or [])
    if not 1 <= len(photos) <= 6:
        raise HTTPException(422, 'Choose between 1 and 6 identification photos')
    images = []
    total = 0
    for photo in photos:
        if photo.content_type not in {'image/jpeg', 'image/png', 'image/webp'}:
            raise HTTPException(415, 'For AI identification, use JPG, PNG, or WebP')
        content = await photo.read(10 * 1024 * 1024 + 1)
        total += len(content)
        if len(content) > 10 * 1024 * 1024 or total > 20 * 1024 * 1024:
            raise HTTPException(413, 'Maximum 10 MB per photo and 20 MB total for identification')
        if not content:
            raise HTTPException(422, 'Identification photos must not be empty')
        images.append({'type': 'image_url', 'image_url': {
            'url': f'data:{photo.content_type};base64,{base64.b64encode(content).decode()}'}})
    diagnostic_id = uuid.uuid4().hex
    def audit(provider, event, **details):
        log_ai_event(diagnostic_id, provider, event,
                     redactions=[image['image_url']['url'].split(',', 1)[1] for image in images], **details)

    def selected(result, provider, fallback_detail=''):
        result['diagnostic_id'] = diagnostic_id
        if fallback_detail:
            result['fallback_detail'] = fallback_detail
        audit(provider, 'selected', fallback_reason=result['fallback_reason'])
        return result
    system = ('Identify electronic hobby components from photos. Return only a JSON object with '
              'keys name, category, manufacturer, model, notes, confidence (high/medium/low), uncertainty. '
              'Only state visible or confidently identifiable markings/specifications. Do not invent '
              'datasheet links, voltage, pinout, or manufacturer. If unclear, give a generic name and '
              'say what additional photo is needed. Use notes for useful visible markings, '
              'interfaces and identifying features. Never infer stock counts, storage location, '
              'project allocation, vendor or purchase price from the photos. Return every requested '
              'field; use empty strings for unknown metadata, never invented values. Keep name '
              'and part number concise. Put supporting detail in notes. Field requirements: ' +
              json.dumps(identification_schema()))
    prompt = ('These photos show the same component from different sides or magnifications. '
              'Combine visible evidence across all photos. Report conflicting markings or uncertainty.')
    fallback_reason = 'claude_not_configured'
    fallback_detail = 'Claude is not configured'
    if claude_key:
        started = time.monotonic()
        audit('claude', 'started', model=os.environ.get('ANTHROPIC_MODEL', 'claude-sonnet-5-5'),
              photo_count=len(images))
        try:
            blocks = []
            for image in images:
                header, data = image['image_url']['url'].split(',', 1)
                blocks.append({'type': 'image', 'source': {'type': 'base64',
                    'media_type': header[5:].split(';')[0], 'data': data}})
            headers = {'Authorization': 'Bearer ' + claude_key, 'anthropic-version': '2026-10-21'}
            workspace = os.environ.get('ANTHROPIC_WORKSPACE_ID', '').strip()
            if workspace:
                headers['anthropic-workspace-id'] = workspace
            async with httpx.AsyncClient(timeout=35) as client:
                response = await client.post('https://api.anthropic.com/v1/messages',
                    headers=headers, json={
                        'model': os.environ.get('ANTHROPIC_MODEL', 'claude-sonnet-5-5'),
                        'max_tokens': 1024, 'system': system,
                        'output_config': {'format': {'type': 'json_schema', 'schema': identification_schema()}},
                        'messages': [{'role': 'user', 'content': [*blocks, {'type': 'text', 'text': prompt}]}]})
                audit('claude', 'response', http_status=response.status_code,
                      elapsed_ms=round((time.monotonic() - started) * 1000),
                      provider_request_id=response.headers.get('request-id'), response=response.text)
                response.raise_for_status()
                text = ''.join(part.get('text', '') for part in response.json()['content'] if part.get('type') == 'text')
            return selected(identification_result(text, 'claude', ''), 'claude')
        except Exception as exc:
            fallback_detail = ai_failure_reason(exc)
            audit('claude', 'failed', reason=fallback_detail, error_type=type(exc).__name__,
                  elapsed_ms=round((time.monotonic() - started) * 1000))
            fallback_reason = 'claude_unavailable'
    else:
        audit('claude', 'skipped', reason=fallback_detail)
    if not key:
        audit('openai', 'skipped', reason='OpenAI backup is not configured')
        raise HTTPException(502, f'Claude identification failed; OpenAI backup is not configured (request {diagnostic_id})')
    started = time.monotonic()
    audit('openai', 'started', model=os.environ.get('OPENAI_MODEL', 'gpt-4.1-mini'),
          reason=fallback_detail, photo_count=len(images))
    try:
        from openai import OpenAI
        client = OpenAI(api_key=key, timeout=35, max_retries=0)
        result = await run_in_threadpool(client.chat.completions.create,
            model=os.environ.get('OPENAI_MODEL', 'gpt-4.1-mini'),
            response_format={'type': 'json_schema', 'json_schema': {
                'name': 'component_identification', 'strict': True, 'schema': identification_schema()}},
            messages=[{'role': 'system', 'content': system},
                      {'role': 'user', 'content': [{'type': 'text', 'text': prompt}, *images]}],
            max_tokens=450)
        text = result.choices[0].message.content
        audit('openai', 'response', response=text,
              elapsed_ms=round((time.monotonic() - started) * 1000))
        return selected(identification_result(text, 'openai', fallback_reason), 'openai', fallback_detail)
    except Exception as exc:
        error_response = getattr(exc, 'response', None)
        if isinstance(error_response, httpx.Response):
            audit('openai', 'response', http_status=error_response.status_code,
                  response=error_response.text)
        audit('openai', 'failed', error_type=type(exc).__name__,
              elapsed_ms=round((time.monotonic() - started) * 1000))
        raise HTTPException(502, f'AI identification unavailable; please retry later (request {diagnostic_id})') from exc


def identification_result(text, provider, fallback_reason):
    text = text.strip()
    if text.startswith('```') and text.endswith('```'):
        text = text.split('\n', 1)[1].rsplit('```', 1)[0].strip()
    result = json.loads(text)
    if not isinstance(result, dict) or not isinstance(result.get('name'), str) or not result['name'].strip():
        raise ValueError('Invalid identification response')
    for field in ['category', 'manufacturer', 'model', 'notes', 'confidence', 'uncertainty']:
        if field in result and not isinstance(result[field], str):
            raise ValueError('Invalid identification field')
    metadata = {field: result.get(field, '').strip() for field in IDENTIFICATION_FIELDS}
    full_suggestions = []
    for field in ['name', 'category', 'manufacturer', 'model']:
        maximum = METADATA_PROPERTIES[field]['maxLength']
        if len(metadata[field]) > maximum:
            full_suggestions.append(f'{field} (full AI suggestion): {metadata[field]}')
            metadata[field] = metadata[field][:maximum].rstrip()
    metadata['notes'] = '\n\n'.join([value for value in [metadata['notes'], *full_suggestions] if value])
    # Every response sent to the UI must already satisfy the inventory save model.
    validated = Component(**metadata).model_dump()
    confidence = result.get('confidence', 'unknown').strip().lower() or 'unknown'
    if confidence not in {'high', 'medium', 'low', 'unknown'}:
        raise ValueError('Invalid confidence')
    uncertainty = result.get('uncertainty', '').strip()
    if len(uncertainty) > 2000:
        raise ValueError('Uncertainty exceeds limit')
    return {**{field: validated[field] for field in IDENTIFICATION_FIELDS},
            'confidence': confidence, 'uncertainty': uncertainty,
            'provider': provider, 'fallback_reason': fallback_reason,
            'metadata_warnings': ['Long labels were shortened; full suggestions are preserved in notes.'] if full_suggestions else []}

@app.get('/api/export.csv')
def export_csv():
    with db() as con:
        rows = [dict(x) for x in con.execute('SELECT * FROM components ORDER BY name').fetchall()]
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=['id'] + FIELDS + ['created_at','updated_at'])
    writer.writeheader()
    writer.writerows(rows)
    return StreamingResponse(iter([output.getvalue()]), media_type='text/csv', headers={'Content-Disposition':'attachment; filename="inventory-portal.csv"'})
