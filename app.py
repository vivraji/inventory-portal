import base64
import csv
import io
import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'data'
UPLOADS = DATA / 'uploads'
DATA.mkdir(exist_ok=True)
UPLOADS.mkdir(exist_ok=True)
DB = DATA / 'inventory.db'
app = FastAPI(title='Inventory Portal', docs_url='/api/docs')
app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')
app.mount('/uploads', StaticFiles(directory=UPLOADS), name='uploads')

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
      min_quantity INTEGER NOT NULL DEFAULT 0 CHECK(min_quantity >= 0),
      location TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '',
      vendor TEXT NOT NULL DEFAULT '', price REAL NOT NULL DEFAULT 0,
      datasheet TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
      image TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    ''')

class Component(BaseModel):
    name: str = Field(min_length=1, max_length=180)
    category: str = Field(default='Other', max_length=80)
    manufacturer: str = Field(default='', max_length=120)
    model: str = Field(default='', max_length=120)
    quantity: int = Field(default=1, ge=0)
    min_quantity: int = Field(default=0, ge=0)
    location: str = Field(default='', max_length=120)
    project: str = Field(default='', max_length=120)
    vendor: str = Field(default='', max_length=120)
    price: float = Field(default=0, ge=0)
    datasheet: str = Field(default='', max_length=1000)
    notes: str = Field(default='', max_length=5000)
    image: str = Field(default='', max_length=300)

FIELDS = list(Component.model_fields)

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
        return get_component(con, ident)

@app.put('/api/components/{ident}')
def update_component(ident: str, component: Component):
    values = component.model_dump()
    with db() as con:
        get_component(con, ident)
        con.execute('UPDATE components SET ' + ','.join(f'{k}=?' for k in FIELDS) + ',updated_at=? WHERE id=?', [values[k] for k in FIELDS] + [now(),ident])
        return get_component(con, ident)

@app.delete('/api/components/{ident}')
def delete_component(ident: str):
    with db() as con:
        old = get_component(con, ident)
        con.execute('DELETE FROM components WHERE id=?', (ident,))
    # Retain uploaded photos to avoid accidental data loss on delete.
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
async def identify(file: UploadFile = File(...)):
    key = os.environ.get('OPENAI_API_KEY', '').strip()
    if not key:
        raise HTTPException(503, 'Add OPENAI_API_KEY to .env and restart to enable AI identification')
    allowed = {'image/jpeg','image/png','image/webp'}
    if file.content_type not in allowed:
        raise HTTPException(415, 'For AI identification, use JPG, PNG, or WebP')
    content = await file.read(10 * 1024 * 1024 + 1)
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(413, 'Maximum photo size is 10 MB')
    try:
        from openai import OpenAI
        client = OpenAI(api_key=key, timeout=35)
        result = client.chat.completions.create(
            model=os.environ.get('OPENAI_MODEL', 'gpt-4.1-mini'),
            response_format={'type':'json_object'},
            messages=[{'role':'system','content':('Identify electronic hobby components from photos. Return JSON object with keys name, category, manufacturer, model, notes, confidence (high/medium/low), uncertainty. Only state markings/specifications visible or confidently identifiable; do not invent datasheet links, voltage, pinout, or manufacturer. If unclear, use generic component name and say what additional photo is needed.')},
            {'role':'user','content':[{'type':'text','text':'Identify this electronic component for a personal inventory. Provide a cautious identification.'}, {'type':'image_url','image_url':{'url':f'data:{file.content_type};base64,{base64.b64encode(content).decode()}'}}]}],
            max_tokens=450)
        return json.loads(result.choices[0].message.content)
    except Exception as exc:
        raise HTTPException(502, f'AI identification unavailable: {type(exc).__name__}') from exc

@app.get('/api/export.csv')
def export_csv():
    with db() as con:
        rows = [dict(x) for x in con.execute('SELECT * FROM components ORDER BY name').fetchall()]
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=['id'] + FIELDS + ['created_at','updated_at'])
    writer.writeheader()
    writer.writerows(rows)
    return StreamingResponse(iter([output.getvalue()]), media_type='text/csv', headers={'Content-Disposition':'attachment; filename="inventory-portal.csv"'})
