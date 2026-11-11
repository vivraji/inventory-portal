const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup(existing = {}) {
    let next = 0;
    const revoked = [], fetched = [];
    const context = vm.createContext({
        URL: {createObjectURL: () => 'blob:' + (++next), revokeObjectURL: url => revoked.push(url)},
        fetch: async path => {
            fetched.push(path);
            return {ok: Boolean(existing[path]), blob: async () => existing[path]};
        }
    });
    vm.runInContext(fs.readFileSync('static/photos.js', 'utf8'), context);
    return {editor: context.createPhotoEditor(), prefill: context.prefillComponentMetadata,
        errors: context.componentFormErrors, formatError: context.formatApiError, revoked, fetched};
}
const photo = (name, size = 10, type = 'image/jpeg') => ({name, size, type});

test('AI combines multiple angles but saves only explicit front/back choices', async () => {
    const {editor} = setup();
    const front = photo('front'), back = photo('back'), closeup = photo('markings');
    editor.setSlot(0, front);
    editor.setSlot(1, back);
    editor.addReferences([closeup]);
    assert.equal((await editor.identificationFiles()).length, 3);
    const uploaded = [];
    const saved = await editor.save(async file => {uploaded.push(file.name);return '/uploads/' + file.name;});
    assert.deepEqual(uploaded, ['front', 'back']);
    assert.equal(saved.image, '/uploads/front');
    assert.equal(saved.image_back, '/uploads/back');
    assert.equal(editor.references().length, 1);
});

test('a reference can be assigned to a catalog slot without duplicate AI input', async () => {
    const {editor} = setup();
    const closeup = photo('markings');
    editor.addReferences([closeup]);
    editor.setSlot(1, closeup);
    assert.equal((await editor.identificationFiles()).length, 1);
    editor.removeReference(0);
    assert.equal(editor.slots()[1].file, closeup);
    const saved = await editor.save(async () => '/uploads/markings');
    assert.equal(saved.image, '');
    assert.equal(saved.image_back, '/uploads/markings');
    assert.throws(() => editor.setSlot(2, closeup), /Only front and back/);
});

test('existing photos are fetched only for explicit identification, never reuploaded', async () => {
    const {editor, fetched} = setup({'/uploads/front.jpg': photo('stored')});
    editor.reset(['/uploads/front.jpg', '']);
    assert.equal(fetched.length, 0);
    const saved = await editor.save(() => assert.fail('must not upload existing file'));
    assert.equal(saved.image, '/uploads/front.jpg');
    assert.equal((await editor.identificationFiles()).length, 1);
    assert.deepEqual(fetched, ['/uploads/front.jpg']);
    editor.clearSlot(0);
    await assert.rejects(editor.identificationFiles(), /Choose 1–6/);
});

test('AI count, total size, unsupported format, and empty image validation', async () => {
    const {editor} = setup();
    editor.addReferences(Array.from({length: 6}, (_, i) => photo('angle' + i)));
    assert.throws(() => editor.addReferences([photo('extra')]), /at most 6/);
    editor.reset();
    editor.addReferences([photo('a', 8e6), photo('b', 8e6), photo('c', 8e6)]);
    await assert.rejects(editor.identificationFiles(), /total at most 20 MB/);
    editor.reset();
    editor.setSlot(0, photo('iphone', 10, 'image/heic'));
    await assert.rejects(editor.identificationFiles(), /Convert HEIC/);
    assert.throws(() => editor.setSlot(0, photo('bad', 10, 'text/html')), /Choose JPG/);
    assert.throws(() => editor.setSlot(0, photo('empty', 0)), /nonempty/);
    assert.throws(() => editor.setSlot(0, photo('large', 11e6)), /at most 10 MB/);
});

test('save retry reuses the successful upload and keeps the failed slot', async () => {
    const {editor} = setup();
    editor.setSlot(0, photo('front'));
    editor.setSlot(1, photo('back'));
    await assert.rejects(editor.save(async file => {
        if (file.name === 'back') throw Error('offline');
        return '/uploads/front';
    }), /offline/);
    const uploaded = [];
    const result = await editor.save(async file => {uploaded.push(file.name);return '/uploads/' + file.name;});
    assert.deepEqual(uploaded, ['back']);
    assert.equal(result.image, '/uploads/front');
    assert.equal(result.image_back, '/uploads/back');
});

test('reset releases preview URLs and removes temporary AI references', () => {
    const {editor, revoked} = setup();
    editor.setSlot(0, photo('front'));
    editor.addReferences([photo('extra')]);
    editor.slots();editor.references();
    editor.reset(['/uploads/old.jpg']);
    assert.equal(revoked.length, 2);
    assert.equal(editor.references().length, 0);
    assert.equal(editor.slots()[0].path, '/uploads/old.jpg');
});

test('AI prefills descriptive metadata and preserves stock and organization', () => {
    const {prefill} = setup();
    const fields = Object.fromEntries(['name', 'category', 'manufacturer', 'model', 'notes',
        'quantity', 'min_quantity', 'location', 'project', 'vendor', 'price', 'datasheet']
        .map(key => [key, {value: 'existing ' + key}]));
    const result = prefill({elements: {namedItem: key => fields[key]}}, {
        name: '  ESP32 board ', category: 'Microcontrollers', manufacturer: 'Espressif',
        model: 'ESP32-WROOM', notes: 'Visible USB connector and antenna.', quantity: 99,
        location: 'invented location', project: 'invented project', price: 999,
        datasheet: 'https://invented.example'
    });
    assert.equal(result.length, 5);
    assert.equal(fields.name.value, 'ESP32 board');
    assert.equal(fields.category.value, 'Microcontrollers');
    assert.equal(fields.manufacturer.value, 'Espressif');
    assert.equal(fields.model.value, 'ESP32-WROOM');
    assert.equal(fields.notes.value, 'Visible USB connector and antenna.');
    for (const key of ['quantity','min_quantity','location','project','vendor','price','datasheet'])
        assert.equal(fields[key].value, 'existing ' + key);
});

test('missing, empty, or invalid AI metadata does not clear existing fields', () => {
    const {prefill} = setup();
    const fields = {name: {value: 'Old name'}, manufacturer: {value: 'Known maker'}, notes: {value: 'My notes'}};
    const result = prefill({elements: {namedItem: key => fields[key]}}, {
        name: 'New name', manufacturer: '', notes: {unexpected: 'object'}
    });
    assert.equal(result.length, 1);
    assert.equal(fields.name.value, 'New name');
    assert.equal(fields.manufacturer.value, 'Known maker');
    assert.equal(fields.notes.value, 'My notes');
});

function formFixture(overrides = {}) {
    const values = {name:'Board', category:'Other', manufacturer:'', model:'', notes:'',
        location:'', project:'', vendor:'', datasheet:'', quantity:'1', min_quantity:'0', price:'0', ...overrides};
    const fields = Object.fromEntries(Object.entries(values).map(([key,value]) => [key,{value}]));
    return {fields, form:{elements:{namedItem:key => fields[key]}}};
}

test('long AI labels fit API limits while complete suggestions are preserved in notes', () => {
    const h = setup(), {fields, form} = formFixture({notes:'My existing note'});
    const suggestion = {name:'N'.repeat(200), category:'C'.repeat(95),
        manufacturer:'M'.repeat(130), model:'Part description '.repeat(15)};
    h.prefill(form, suggestion);
    assert.equal(fields.name.value.length, 180);
    assert.equal(fields.category.value.length, 80);
    assert.equal(fields.manufacturer.value.length, 120);
    assert.ok(fields.model.value.length <= 120);
    for (const value of Object.values(suggestion)) assert.ok(fields.notes.value.includes(value.trim()));
    assert.ok(fields.notes.value.includes('My existing note'));
    assert.equal(h.errors(form).length, 0);
});

test('oversized notes stay intact and get an actionable validation message', () => {
    const h = setup(), {fields, form} = formFixture();
    h.prefill(form, {name:'Board', notes:'n'.repeat(5001)});
    assert.equal(fields.notes.value.length, 5001);
    assert.match(h.errors(form)[0], /Notes must be at most 5000 characters/);
});

test('local form checks report whitespace names, long fields and invalid quantities', () => {
    const h = setup();
    for (const [overrides, message] of [[{name:'   '}, /component name/],
        [{model:'x'.repeat(121)}, /Model \/ part number.*120/],
        [{location:'x'.repeat(121)}, /Storage location.*120/],
        [{quantity:'1.5'}, /Quantity.*whole number/], [{min_quantity:'-1'}, /Low-stock threshold/],
        [{price:'Infinity'}, /Unit price/], [{quantity:''}, /Quantity/]]) {
        assert.match(h.errors(formFixture(overrides).form).join(' '), message);
    }
});

test('API validation details show the field and constraint without echoing submitted values', () => {
    const {formatError} = setup();
    const message = formatError({detail:[
        {loc:['body','model'],msg:'String should have at most 120 characters',input:'private input'},
        {loc:['body','notes'],msg:'String should have at most 5000 characters',input:'private notes'}]},422);
    assert.match(message,/Model \/ part number:.*120 characters/);
    assert.match(message,/Notes:.*5000 characters/);
    assert.doesNotMatch(message,/private/);
    assert.equal(formatError({detail:'Maximum photo size is 10 MB'},413),'Maximum photo size is 10 MB');
    assert.equal(formatError(undefined,500),'Request failed (500)');
});

test('AI label shortening preserves Unicode characters at the server limit', () => {
    const h = setup(), {fields, form} = formFixture();
    const full = 'n'.repeat(179) + '🔌' + ' extra';
    h.prefill(form,{name:full});
    assert.equal(Array.from(fields.name.value).length,180);
    assert.ok(fields.name.value.endsWith('🔌'));
    assert.ok(fields.notes.value.includes(full));
    assert.equal(h.errors(form).length,0);
});
