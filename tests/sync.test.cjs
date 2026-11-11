const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup(read) {
    const window = new EventTarget(), document = new EventTarget();
    document.visibilityState = 'visible';
    const sources = [], messages = [];
    class Source extends EventTarget {
        constructor(url) { super(); this.url = url; sources.push(this); }
        close() { this.closed = true; }
    }
    window.EventSource = Source;
    const context = vm.createContext({window, document, EventSource: Source, setTimeout, clearTimeout});
    vm.runInContext(fs.readFileSync('static/sync.js', 'utf8'), context);
    const sync = context.createInventorySync(read, text => messages.push(text));
    return {sync, window, document, sources, messages};
}
const tick = () => new Promise(resolve => setTimeout(resolve, 150));

test('initial refresh, reconnect, focus coalescing, visibility and lifecycle', async () => {
    let reads = 0;
    const h = setup(async () => { reads++; });
    try {
        h.sync.start();
        await tick();
        assert.equal(reads, 1);
        const source = h.sources[0];
        source.onopen();
        source.dispatchEvent(new Event('inventory'));
        h.window.dispatchEvent(new Event('focus'));
        h.document.dispatchEvent(new Event('visibilitychange'));
        await tick();
        assert.equal(reads, 2);
        source.onerror();
        assert.match(h.messages.at(-1), /Reconnecting/);
        source.onopen();
        await tick();
        assert.equal(reads, 3);
        assert.equal(h.sources.length, 1);
        h.document.visibilityState = 'hidden';
        h.document.dispatchEvent(new Event('visibilitychange'));
        await tick();
        assert.equal(reads, 3);
        h.document.visibilityState = 'visible';
        h.document.dispatchEvent(new Event('visibilitychange'));
        await tick();
        assert.equal(reads, 4);
        h.window.dispatchEvent(new Event('pagehide'));
        assert.equal(source.closed, true);
        h.window.dispatchEvent(new Event('pageshow'));
        await tick();
        assert.equal(h.sources.length, 2);
        assert.equal(reads, 5);
    } finally { h.sync.stop(); }
});

test('changes during an in-flight read get a serialized follow-up', async () => {
    let reads = 0, release;
    const h = setup(() => { reads++; return new Promise(resolve => { release = resolve; }); });
    try {
        h.sync.start();
        const pending = h.sync.refresh();
        assert.equal(reads, 1);
        release();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(reads, 2);
        release();
        await pending;
    } finally { h.sync.stop(); }
});

test('failed reads recover and unsupported browsers retain focus fallback', async () => {
    let reads = 0;
    const h = setup(async () => { if (++reads === 1) throw Error('offline'); });
    delete h.window.EventSource;
    try {
        h.sync.start();
        await tick();
        assert.match(h.messages[0], /unavailable/);
        assert.match(h.messages.at(-1), /Retrying/);
        h.window.dispatchEvent(new Event('focus'));
        await tick();
        assert.equal(reads, 2);
        assert.equal(h.sources.length, 0);
    } finally { h.sync.stop(); }
});

test('background UI refresh preserves selected filters and unsaved form fields', async () => {
    const nodes = {
        types: {}, units: {}, low: {},
        categoryFilter: select('Old category'), locationFilter: select('Old bin'),
        search: {value: 'board'},
        form: {elements: {name: {value: 'Unsaved component'}, quantity: {value: '7'}}},
        photo: {files: ['unsaved photo']}, overlay: {className: 'overlay open'}
    };
    function select(value) {
        return {value, options: [], replaceChildren(option) {this.options = [option];},
            add(option) {this.options.push(option);}};
    }
    const html = fs.readFileSync('static/index.html', 'utf8');
    const inline = html.split('<script>')[1].split("window.addEventListener('keydown'")[0];
    const context = vm.createContext({
        document: {getElementById: id => nodes[id]},
        Option: function(text, value) {this.text = text; this.value = value;},
        setTimeout, clearTimeout, AbortController,
        fetch: async url => ({ok: true, json: async () => url === '/api/components' ? [] :
            {types: 2, units: 8, low_stock: 1, categories: ['New category'], locations: ['New bin']}})
    });
    vm.runInContext(fs.readFileSync('static/photos.js','utf8'),context);
    vm.runInContext(inline + '\nrender=()=>{};toast=message=>{throw Error(message)};', context);
    await context.refreshInventory();
    assert.equal(nodes.categoryFilter.value, 'Old category');
    assert.equal(nodes.locationFilter.value, 'Old bin');
    assert.ok(nodes.categoryFilter.options.some(x => x.value === 'Old category'));
    assert.equal(nodes.form.elements.name.value, 'Unsaved component');
    assert.equal(nodes.form.elements.quantity.value, '7');
    assert.equal(nodes.photo.files[0], 'unsaved photo');
    assert.equal(nodes.overlay.className, 'overlay open');
    assert.equal(nodes.search.value, 'board');
    assert.equal(nodes.units.textContent, 8);
    nodes.categoryFilter.value='sensor module';
    context.fetch=async url=>({ok:true,json:async()=>url==='/api/components'?[]:
        {types:0,units:0,low_stock:0,categories:['Sensor Module'],locations:[]}});
    await context.refreshInventory();
    assert.equal(nodes.categoryFilter.value,'Sensor Module');
    assert.equal(nodes.categoryFilter.options.length,2); // All categories + one canonical label.
});

test('a failed read retries automatically without focus or another event', async () => {
    let reads = 0;
    const h = setup(async () => { if (++reads === 1) throw Error('offline'); });
    try {
        h.sync.start();
        await new Promise(resolve => setTimeout(resolve, 3200));
        assert.equal(reads, 2);
        assert.doesNotMatch(h.messages.at(-1), /failed/);
    } finally { h.sync.stop(); }
});
