// Reviews are explicit paid actions; applying decisions is a separate user action.
(() => {
    let selected = new Set(), current = null, running = false, applying = false, generation = 0;
    const el = id => document.getElementById(id);
    const node = (tag,text,className='') => {const e=document.createElement(tag);e.textContent=text;e.className=className;return e};
    const labels = {likely_same_component:'Possible duplicate',related_but_distinct:'Related but distinct',
        different_components:'Different components — remove link',insufficient_evidence:'Insufficient evidence',automatic:'Use automatic matcher'};
    function status(text){el('reviewStatus').textContent=text}
    function buttons(){el('runReview').disabled=running||applying||selected.size<2||selected.size>8;el('runReview').textContent=running?'Reviewing…':'Run AI review ('+selected.size+' selected)'}
    function selection(){
        const query=el('reviewSearch').value.trim();const list=el('reviewComponents');list.replaceChildren();
        for(const c of components.filter(c=>componentMatchesSearch(c,query))){
            const label=node('label','','review-component');const input=document.createElement('input');input.type='checkbox';input.checked=selected.has(c.id);
            input.setAttribute('aria-label','Review '+c.inventory_number);input.disabled=running;
            input.onchange=()=>{if(input.checked&&selected.size===8){input.checked=false;status('Choose at most 8 components per review.');return}if(input.checked)selected.add(c.id);else selected.delete(c.id);buttons()};
            label.append(input);
            if((c.image||c.image_back||'').startsWith('/uploads/')){const image=document.createElement('img');image.src=c.image||c.image_back;image.alt='';image.loading='lazy';label.append(image)}
            label.append(node('span',c.inventory_number+' · '+c.name));list.append(label);
        }
        buttons();
    }
    async function history(){
        try{const rows=await api('/api/similarity-reviews');const select=el('reviewHistory');select.replaceChildren(new Option('Choose a saved review',''));
            for(const row of rows)select.add(new Option(new Date(row.created_at).toLocaleString()+' · '+row.component_count+' components',row.id));
        }catch(e){status(e.message)}
    }
    window.openAIReview=()=>{
        if(!el('reviewOverlay'))build();
        el('reviewOverlay').classList.add('open');document.body.classList.add('modal-open');
        selected=new Set([...selected].filter(id=>components.some(c=>c.id===id)));selection();history();el('reviewSearch').focus();
    };
    window.closeAIReview=()=>{el('reviewOverlay')?.classList.remove('open');if(!el('overlay').classList.contains('open')&&!el('comparisonOverlay').classList.contains('open'))document.body.classList.remove('modal-open')};
    function build(){
        const overlay=node('div','','overlay review-overlay');overlay.id='reviewOverlay';overlay.onclick=e=>{if(e.target===overlay)closeAIReview()};
        const modal=node('div','','modal review-modal');modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','reviewTitle');
        const header=node('div','','modalhead'),title=node('h2','AI similarity review');title.id='reviewTitle';const close=node('button','Close','btn');close.type='button';close.onclick=closeAIReview;header.append(title,close);modal.append(header);
        modal.append(node('p','Select 2–8 components. All selected pairs will be reviewed, including pairs not currently linked. Only inventory numbers, names, categories, manufacturers, models and notes are sent. Photos, stock and storage are not sent.'));
        modal.append(node('p','Paid API calls: “Both” sends the same metadata to Claude and OpenAI independently. No fallback calls or inventory changes occur automatically. Review results before applying relationship decisions.','notice'));
        const search=node('input','', 'field');search.id='reviewSearch';search.placeholder='Search components to select';search.setAttribute('aria-label','Search review components');search.oninput=selection;
        const list=node('div','','review-components');list.id='reviewComponents';modal.append(search,list);
        const providerLabel=node('label','Review with');const provider=document.createElement('select');provider.id='reviewProvider';provider.className='field';
        for(const [value,text] of [['both','Both: Claude and OpenAI'],['claude','Claude only'],['openai','OpenAI only']])provider.add(new Option(text,value));providerLabel.append(provider);modal.append(providerLabel);
        const run=node('button','Run AI review','btn primary');run.type='button';run.id='runReview';run.onclick=runReview;modal.append(run);
        const message=node('p','','notice');message.id='reviewStatus';message.setAttribute('role','status');modal.append(message);
        const historyLabel=node('label','Saved reviews (latest 20)');const saved=document.createElement('select');saved.id='reviewHistory';saved.className='field';
        saved.onchange=async()=>{if(!saved.value||running||applying)return;const token=++generation;try{const r=await api('/api/similarity-reviews/'+encodeURIComponent(saved.value));if(token===generation)showResults(r)}catch(e){status(e.message)}};
        historyLabel.append(saved);modal.append(historyLabel);const results=node('div');results.id='reviewResults';modal.append(results);overlay.append(modal);document.body.append(overlay);
    }
    async function runReview(){
        if(running||applying||selected.size<2||selected.size>8)return;
        const token=++generation;running=true;buttons();selection();el('reviewProvider').disabled=true;el('reviewHistory').disabled=true;
        el('reviewResults').replaceChildren();current=null;status('Requesting independent AI reviews. This can take up to two minutes…');
        try{const r=await api('/api/similarity-reviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({component_ids:[...selected],provider:el('reviewProvider').value})});
            if(token===generation){showResults(r);await history()}
        }catch(e){status(e.name==='AbortError'?'The request timed out. Check saved reviews before retrying to avoid a duplicate paid request.':e.message)}
        finally{running=false;el('reviewProvider').disabled=false;el('reviewHistory').disabled=false;selection()}
    }
    function showResults(review){
        current=review;const root=el('reviewResults');root.replaceChildren();
        status('Saved review · '+new Date(review.created_at).toLocaleString()+'. Metadata only. Choose classifications and check the pairs you want to apply.');
        const download=node('a','Download HTML review report','btn');download.href='/api/similarity-reviews/'+encodeURIComponent(review.id)+'/report';root.append(download);
        for(const provider of review.providers){root.append(node('p',provider.provider+' · '+provider.model+' · '+(provider.status==='success'?'Complete':provider.error),'notice'))}
        for(const pair of review.pairs){
            const section=node('section','','review-pair');section.append(node('h3',pair.pair_id+' · '+pair.left.inventory_number+' ↔ '+pair.right.inventory_number));
            section.append(node('p',pair.left.name+' ↔ '+pair.right.name));
            const grid=node('div','','review-grid');let usable=false;
            for(const provider of review.providers){
                const panel=node('article');panel.append(node('h4',provider.provider));const result=provider.results.find(r=>r.pair_id===pair.pair_id);
                if(result){usable=true;panel.append(node('strong',labels[result.verdict]+' · '+result.confidence+' confidence'));
                    for(const [key,label] of [['reason','Reason'],['differences','Differences'],['evidence_needed','Evidence needed']])panel.append(node('p',label+': '+result[key]));
                }else panel.append(node('p',provider.error||'No usable result'));grid.append(panel);
            }
            section.append(grid);
            const choiceLabel=node('label','Your classification');const choice=document.createElement('select');choice.className='field';choice.dataset.pair=pair.pair_id;choice.disabled=!usable;
            choice.add(new Option('Choose a classification',''));
            for(const key of ['likely_same_component','related_but_distinct','different_components','automatic'])choice.add(new Option(labels[key],key));choiceLabel.append(choice);
            const applyLabel=node('label','', 'compare-choice');const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.dataset.applyPair=pair.pair_id;checkbox.disabled=!usable;checkbox.setAttribute('aria-label','Apply '+pair.pair_id);applyLabel.append(checkbox,document.createTextNode('Apply this pair'));
            section.append(choiceLabel,applyLabel);root.append(section);
        }
        const apply=node('button','Apply checked classifications','btn primary');apply.type='button';apply.id='applyReview';apply.onclick=applyChoices;apply.disabled=!review.providers.some(p=>p.status==='success');root.append(apply);
        root.append(node('p','Different removes the link and warning; related or possible duplicate keeps a reviewed link and warning. Automatic removes a previous override. No component is merged, deleted or edited. Changed metadata invalidates a decision.'));
    }
    async function applyChoices(){
        if(applying||!current)return;
        const choices=[];
        for(const check of el('reviewResults').querySelectorAll('input[data-apply-pair]:checked')){
            const pair=check.dataset.applyPair;const choice=[...el('reviewResults').querySelectorAll('select[data-pair]')].find(s=>s.dataset.pair===pair);
            if(!choice?.value){status('Choose a classification for every checked pair.');return}choices.push({pair_id:pair,verdict:choice.value});
        }
        if(!choices.length){status('Check at least one pair to apply.');return}
        applying=true;el('applyReview').disabled=true;el('runReview').disabled=true;el('reviewHistory').disabled=true;
        try{const r=await api('/api/similarity-reviews/'+encodeURIComponent(current.id)+'/apply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({choices})});
            await refresh();status('Applied '+r.applied+' classifications. Inventory records and photos are unchanged.');
        }catch(e){status(e.message)}finally{applying=false;el('applyReview').disabled=false;el('reviewHistory').disabled=false;buttons()}
    }
})();
