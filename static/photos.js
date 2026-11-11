const COMPONENT_TEXT_LIMITS = {name: 180, category: 80, manufacturer: 120, model: 120,
    location: 120, project: 120, vendor: 120, datasheet: 1000, notes: 5000};
const COMPONENT_LABELS = {name: 'Component name', category: 'Category', manufacturer: 'Manufacturer',
    model: 'Model / part number', location: 'Storage location', project: 'Project', vendor: 'Vendor',
    datasheet: 'Datasheet URL', notes: 'Notes', quantity: 'Quantity', min_quantity: 'Low-stock threshold', price: 'Unit price'};

function categoryKey(value) {
    return String(value||'').normalize('NFKC').toLowerCase().replace(/\s*([/&])\s*/g,' $1 ').replace(/\s+/g,' ').trim();
}

function formatApiError(payload, status) {
    if (typeof payload?.detail === 'string') return payload.detail;
    if (payload?.detail?.code === 'similar_components') return payload.detail.message;
    if (Array.isArray(payload?.detail)) {
        const messages = payload.detail.map(issue => {
            const path = Array.isArray(issue.loc) ? issue.loc.filter(p => p !== 'body') : [];
            const field = path[0];
            return (COMPONENT_LABELS[field] || field || 'Form') + ': ' + (issue.msg || 'Invalid value');
        });
        if (messages.length) return messages.join('; ');
    }
    return 'Request failed (' + status + ')';
}

function componentFormErrors(form) {
    const errors = [];
    for (const [key, max] of Object.entries(COMPONENT_TEXT_LIMITS)) {
        const value = String(form.elements.namedItem(key)?.value || '').trim();
        if (key === 'name' && !value) errors.push('Enter a component name.');
        const length = Array.from(value).length;
        if (length > max) errors.push(COMPONENT_LABELS[key] + ' must be at most ' + max + ' characters (currently ' + length + ').');
    }
    for (const key of ['quantity','min_quantity','price']) {
        const field = form.elements.namedItem(key);
        const value = Number(field?.value);
        if (!field || !String(field.value).trim() || !Number.isFinite(value) || value < 0 ||
            (key !== 'price' && !Number.isInteger(value)))
            errors.push(COMPONENT_LABELS[key] + ' must be a non-negative ' + (key === 'price' ? 'number.' : 'whole number.'));
    }
    return errors;
}

// Preserve long AI labels in notes rather than sending invalid fields or losing text.
function prefillComponentMetadata(form, suggestion) {
    const filled = [], fullSuggestions = [];
    for (const key of ['name', 'category', 'manufacturer', 'model']) {
        const field = form.elements.namedItem(key);
        if (field && typeof suggestion[key] === 'string' && suggestion[key].trim()) {
            const value = suggestion[key].trim();
            if (Array.from(value).length > COMPONENT_TEXT_LIMITS[key])
                fullSuggestions.push(COMPONENT_LABELS[key] + ' (full AI suggestion): ' + value);
            field.value = Array.from(value).slice(0, COMPONENT_TEXT_LIMITS[key]).join('').trimEnd();
            filled.push(key);
        }
    }
    const notes = form.elements.namedItem('notes');
    if (notes) {
        const suggested = typeof suggestion.notes === 'string' ? suggestion.notes.trim() : '';
        if (suggested || fullSuggestions.length) {
            notes.value = [suggested || notes.value, ...fullSuggestions].filter(Boolean).join('\n\n');
            filled.push('notes');
        }
    }
    return filled;
}

/* Catalog slots are independent of the temporary AI reference set. */
function createPhotoEditor(changed = () => {}) {
    let slots = [{path: '', file: null}, {path: '', file: null}], references = [];
    const urls = new Map();
    const limit = 10 * 1024 * 1024;
    function validate(file) {
        if (!['image/jpeg','image/png','image/webp','image/heic'].includes(file.type))
            throw Error('Choose JPG, PNG, WebP, or HEIC photos.');
        if (!file.size || file.size > limit) throw Error('Photos must be nonempty and at most 10 MB each.');
    }
    function allFiles() {
        return [...new Set([...slots.map(s => s.file).filter(Boolean), ...references])];
    }
    function preview(file) {
        if (!urls.has(file)) urls.set(file, URL.createObjectURL(file));
        return urls.get(file);
    }
    return {
        reset(paths = []) {
            for (const url of urls.values()) URL.revokeObjectURL(url);
            urls.clear();
            slots = [0,1].map(i => ({path: paths[i] || '', file: null}));
            references = [];
            changed();
        },
        slots: () => slots.map(s => ({...s, preview: s.file ? preview(s.file) : s.path})),
        references: () => references.map(file => ({file, preview: preview(file)})),
        setSlot(index, file) {
            if (![0,1].includes(index)) throw Error('Only front and back catalog photos are supported.');
            validate(file);
            slots[index] = {path: '', file};
            changed();
        },
        clearSlot(index) { slots[index] = {path: '', file: null}; changed(); },
        addReferences(files) {
            const added = Array.from(files);
            added.forEach(validate);
            if (new Set([...allFiles(), ...added]).size + slots.filter(s => s.path).length > 6)
                throw Error('Use at most 6 identification photos, including front and back.');
            references = [...new Set([...references, ...added])];
            changed();
        },
        removeReference(index) { references.splice(index, 1); changed(); },
        async identificationFiles() {
            const result = allFiles();
            for (const slot of slots) {
                if (!slot.path) continue;
                const response = await fetch(slot.path);
                if (!response.ok) throw Error('Could not load an existing catalog photo.');
                result.push(await response.blob());
            }
            if (!result.length || result.length > 6) throw Error('Choose 1–6 identification photos.');
            let total = 0;
            for (const file of result) {
                validate(file);
                if (file.type === 'image/heic') throw Error('Convert HEIC photos to JPG, PNG, or WebP before AI identification.');
                total += file.size;
            }
            if (total > 20 * 1024 * 1024) throw Error('Identification photos must total at most 20 MB.');
            return result;
        },
        async save(upload) {
            // Only the two explicitly chosen catalog slots are uploaded.
            const paths = [];
            for (const slot of slots) {
                if (slot.file) {
                    slot.path = await upload(slot.file);
                    slot.file = null;
                }
                paths.push(slot.path);
            }
            return {image: paths[0], image_back: paths[1]};
        }
    };
}
