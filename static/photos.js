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
