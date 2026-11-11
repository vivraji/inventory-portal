function renderComponentComparison(container, left, right) {
    container.replaceChildren();
    const table = document.createElement('table');
    table.className = 'comparison-table';
    const head = document.createElement('thead'), titles = document.createElement('tr');
    for (const title of ['Detail',left.inventory_number || 'Unsaved component',right.inventory_number || 'Unsaved component']) {
        const cell = document.createElement('th');cell.scope='col';cell.textContent=title;titles.append(cell);
    }
    head.append(titles);table.append(head);
    const body = document.createElement('tbody');
    const fields = [['name','Name'],['category','Category'],['manufacturer','Manufacturer'],['model','Model / part'],
        ['quantity','Quantity'],['min_quantity','Low-stock threshold'],['location','Storage'],['project','Project'],
        ['vendor','Vendor'],['price','Unit price (USD)'],['datasheet','Datasheet URL'],['notes','Notes']];
    for (const [key,label] of fields) {
        const row = document.createElement('tr'), heading = document.createElement('th');
        heading.scope='row';heading.textContent=label;row.append(heading);
        for (const component of [left,right]) {
            const cell = document.createElement('td');cell.textContent=String(component[key] ?? '') || '—';
            if (String(left[key] ?? '') !== String(right[key] ?? '')) cell.className='comparison-different';
            row.append(cell);
        }
        body.append(row);
    }
    const row = document.createElement('tr'), heading = document.createElement('th');
    heading.scope='row';heading.textContent='Front / back';row.append(heading);
    for (const component of [left,right]) {
        const cell = document.createElement('td'), photos = document.createElement('div');photos.className='comparison-photos';
        for (const [key,label] of [['image','Front'],['image_back','Back']]) {
            const src = component[key] || '';
            if (src.startsWith('/uploads/') || src.startsWith('blob:')) {
                const image = document.createElement('img');image.src=src;image.alt=label+' — '+component.name;photos.append(image);
            }
        }
        cell.append(photos);if (!photos.children.length) cell.textContent='No photos';row.append(cell);
    }
    body.append(row);table.append(body);container.append(table);
}

function renderSimilarWarning(container, matches, draft, compare, keepEditing, saveSeparate) {
    container.replaceChildren();container.style.display='block';
    const title = document.createElement('h3');title.textContent='Possible similar components';container.append(title);
    const message = document.createElement('p');
    message.textContent='Compare these entries before saving. No existing record will be merged or changed.';container.append(message);
    for (const match of matches) {
        const item = document.createElement('div');item.className='similar-match';
        const name = document.createElement('strong');name.textContent=match.inventory_number+' · '+match.name;
        const details = document.createElement('p');
        details.textContent=[match.similarity_reason,match.model,match.location,match.quantity+' in stock'].filter(Boolean).join(' · ');
        const button = document.createElement('button');button.type='button';button.className='btn';
        button.textContent='Compare with draft';button.onclick=()=>compare(draft,match);
        item.append(name,details,button);container.append(item);
    }
    const actions = document.createElement('div');actions.className='actions';
    const saveLabel=(draft.inventory_number||'').startsWith('INV-')?'Save current entry anyway':'Save separately anyway';
    for (const [text,action] of [['Keep editing',keepEditing],[saveLabel,saveSeparate]]) {
        const button = document.createElement('button');button.type='button';button.className='btn';button.textContent=text;button.onclick=action;actions.append(button);
    }
    container.append(actions);
}
