// Static fixtures only: no live inventory, application server, keys, or AI calls.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium, webkit} = require('playwright');
const root = path.resolve(__dirname, '..', 'static');
const sizes = [[320,568],[375,667],[390,844],[430,932],[568,320],[844,390],[768,1024],[1024,768],[1440,900]];
const component = {id:'fixture', inventory_number:'INV-000001', name:'Component'.repeat(20), category:'Category'.repeat(10),
    model:'LongPartNumber'.repeat(8), manufacturer:'Maker', notes:'Notes', project:'Project',
    location:'Storage'.repeat(16), quantity:1, min_quantity:1, image:'', image_back:''};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGMImXCCJMQwqmFUw/DVAAAVcawQr3EqRwAAAABJRU5ErkJggg==','base64');

async function fixtureServer() {
    const server = http.createServer(async (request,response) => {
        const pathname = new URL(request.url,'http://localhost').pathname;
        const file = pathname === '/' ? path.join(root,'index.html') : pathname === '/release-notes' ? path.join(root,'release-notes.html') : path.resolve(root,'.' + pathname.replace(/^\/static/,''));
        if (!file.startsWith(root + path.sep)) { response.writeHead(404).end();return; }
        try {
            const body = await fs.readFile(file);
            const type = {'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)] || 'application/octet-stream';
            response.writeHead(200,{'content-type':type});response.end(body);
        } catch {response.writeHead(404).end();}
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    return {server,url:'http://127.0.0.1:' + server.address().port};
}

async function assertFits(page, modal = false) {
    const metrics = await page.evaluate(selector => {
        const viewport = window.visualViewport;
        const visible = {left:viewport?.offsetLeft || 0,top:viewport?.offsetTop || 0,
            width:viewport?.width || innerWidth,height:viewport?.height || innerHeight};
        const dialog = document.querySelector(selector), bounds = dialog.getBoundingClientRect();
        const toast = document.getElementById('toast').getBoundingClientRect();
        const overflow = [...dialog.querySelectorAll('input,select,textarea,button,.notice,#aiStatus')]
            .filter(el => el.getBoundingClientRect().width > 0)
            .filter(el => el.getBoundingClientRect().right > bounds.right + 1 || el.getBoundingClientRect().left < bounds.left - 1)
            .map(el => el.id || el.name || el.tagName);
        return {width:innerWidth, pageWidth:document.documentElement.scrollWidth,
            modalWidth:dialog.clientWidth, modalScrollWidth:dialog.scrollWidth,
            bounds:{left:bounds.left,right:bounds.right,top:bounds.top,bottom:bounds.bottom},visible,overflow,
            toast:{left:toast.left,right:toast.right,top:toast.top,bottom:toast.bottom,width:toast.width}};
    },modal === 'comparison' ? '.comparison-modal' : '.modal');
    assert.ok(metrics.pageWidth <= metrics.width + 1, JSON.stringify(metrics));
    if (metrics.toast.width) {
        assert.ok(metrics.toast.left >= metrics.visible.left - 1 &&
            metrics.toast.right <= metrics.visible.left + metrics.visible.width + 1 &&
            metrics.toast.top >= metrics.visible.top - 1 &&
            metrics.toast.bottom <= metrics.visible.top + metrics.visible.height + 1,JSON.stringify(metrics));
    }
    if (modal) {
        assert.ok(metrics.modalScrollWidth <= metrics.modalWidth + 1, JSON.stringify(metrics));
        assert.deepEqual(metrics.overflow,[],JSON.stringify(metrics));
        assert.ok(metrics.bounds.left >= metrics.visible.left - 1 &&
            metrics.bounds.right <= metrics.visible.left + metrics.visible.width + 1,JSON.stringify(metrics));
        assert.ok(metrics.bounds.top >= metrics.visible.top - 1 &&
            metrics.bounds.bottom <= metrics.visible.top + metrics.visible.height + 1,JSON.stringify(metrics));
    }
}

for (const [name,engine] of Object.entries({chromium,webkit})) {
    test(name + ': dashboard, photo form and long AI responses fit all viewports', async () => {
        const fixture = await fixtureServer();
        let browser;
        try {
            browser = await engine.launch({headless:true});
            for (const [width,height] of sizes) {
                const context = await browser.newContext({viewport:{width,height},isMobile:width < 800,hasTouch:width < 800});
                const page = await context.newPage(), errors = [];
                page.on('pageerror',error => errors.push(error.message));
                await page.route('**/api/**', async route => {
                    const endpoint = new URL(route.request().url()).pathname;
                    if (endpoint === '/api/events') return route.fulfill({contentType:'text/event-stream',body:'retry: 3000\n\n'});
                    const data = endpoint === '/api/components' ? [component] : endpoint === '/api/stats' ?
                        {types:1,units:1,low_stock:1,categories:[component.category],locations:[component.location]} :
                        {name:component.name,category:component.category,manufacturer:'Maker',model:component.model,
                         notes:'N'.repeat(5000),uncertainty:'Markings unclear. '.repeat(30),confidence:'high',
                         provider:'openai',fallback_detail:'Claude returned an unusable response',diagnostic_id:'a'.repeat(32)};
                    return route.fulfill({json:data});
                });
                await page.goto(fixture.url);
                await page.locator('.component').waitFor();
                await assertFits(page);
                await page.getByRole('button',{name:/Add component/}).click();
                assert.equal(await page.locator('[name=min_quantity]').inputValue(),'1');
                await assertFits(page,true);
                for (const selector of ['#photo','#photoBack'])
                    await page.locator(selector).setInputFiles({name:'component-' + 'closeup-'.repeat(20) + '.png',mimeType:'image/png',buffer:png});
                await page.locator('#aiPhotos').setInputFiles(Array.from({length:4},(_,i) => ({name:'angle'+i+'.png',mimeType:'image/png',buffer:png})));
                await page.getByRole('button',{name:/Identify with AI/}).click();
                await page.waitForFunction(() => document.getElementById('aiStatus').textContent.includes('Log ID:'));
                await page.evaluate(() => {showSaveError('Model validation failed: '+ 'description'.repeat(40));toast('A long toast: '+ 'notice'.repeat(50));});
                await assertFits(page,true);
                const save = page.getByRole('button',{name:'Save component'});
                await save.scrollIntoViewIfNeeded();
                assert.ok(await save.isVisible());
                if (process.env.LAYOUT_SCREENSHOTS && width === 390) {
                    await page.locator('#overlay .modal').evaluate(el => {el.scrollTop = 0;});
                    await fs.mkdir(process.env.LAYOUT_SCREENSHOTS,{recursive:true});
                    await page.screenshot({path:path.join(process.env.LAYOUT_SCREENSHOTS,name+'-phone.png')});
                }
                if (width < 800) assert.ok(Number.parseFloat(await page.locator('[name=name]').evaluate(el => getComputedStyle(el).fontSize)) >= 16);
                // Rotate the already open form; selected photos and metadata must survive.
                await page.setViewportSize({width:height,height:width});
                await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--view-width')) - innerWidth) < 2);
                await assertFits(page,true);
                assert.equal(await page.locator('[name=name]').inputValue(),component.name);
                assert.equal(await page.locator('#aiPhotoList img').count(),4);
                assert.deepEqual(errors,[],name+' '+width+'x'+height);
                await context.close();
            }
        } finally {
            if (browser) await browser.close();
            await new Promise(resolve => fixture.server.close(resolve));
        }
    });

    test(name + ': form tracks a reduced visual viewport without losing input', async () => {
        const fixture = await fixtureServer();
        let browser;
        try {
            browser = await engine.launch({headless:true});
            const page = await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
            await page.addInitScript(() => {
                const viewport = new EventTarget();
                Object.assign(viewport,{height:844,width:390,offsetTop:0,offsetLeft:0});
                Object.defineProperty(window,'visualViewport',{value:viewport});
            });
            await page.route('**/api/**', route => {
                if (route.request().url().endsWith('/api/events'))
                    return route.fulfill({contentType:'text/event-stream',body:'retry: 3000\n\n'});
                return route.fulfill({json:route.request().url().endsWith('/api/components') ? [] :
                    {types:0,units:0,low_stock:0,categories:[],locations:[]}});
            });
            await page.goto(fixture.url);
            await page.getByRole('button',{name:/Add component/}).click();
            await page.locator('[name=name]').fill('Unsaved mobile component');
            await page.evaluate(() => {
                Object.assign(window.visualViewport,{height:280,width:390,offsetTop:40,offsetLeft:0});
                window.visualViewport.dispatchEvent(new Event('resize'));
                toast('Keyboard notice: ' + 'Long message. '.repeat(100));
            });
            await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--view-height') === '280px');
            await assertFits(page,true);
            await page.getByRole('button',{name:'Save component'}).scrollIntoViewIfNeeded();
            const bounds = await page.getByRole('button',{name:'Save component'}).boundingBox();
            assert.ok(bounds.y >= 40 && bounds.y + bounds.height <= 320);
            assert.equal(await page.locator('[name=name]').inputValue(),'Unsaved mobile component');
            // Simulate a zoomed visible area, while retaining browser zoom support.
            await page.evaluate(() => {
                Object.assign(window.visualViewport,{height:350,width:260,offsetTop:10,offsetLeft:20});
                window.visualViewport.dispatchEvent(new Event('resize'));
            });
            await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--view-width') === '260px');
            await assertFits(page,true);
            await page.evaluate(() => {
                Object.assign(window.visualViewport,{height:844,width:390,offsetTop:0,offsetLeft:0});
                window.visualViewport.dispatchEvent(new Event('resize'));
            });
            await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--view-height') === '844px');
            await assertFits(page,true);
            await page.getByRole('button',{name:'Cancel',exact:true}).click();
            assert.equal(await page.locator('body').evaluate(el => el.classList.contains('modal-open')),false);
        } finally {
            if (browser) await browser.close();
            await new Promise(resolve => fixture.server.close(resolve));
        }
    });

    test(name + ': inventory comparison and intentional similar-save confirmation', async () => {
        const fixture = await fixtureServer();let browser;
        try {
            browser = await engine.launch({headless:true});
            for (const [width,height] of [[320,568],[390,844],[844,390],[1440,900]]) {
                const page = await browser.newPage({viewport:{width,height},isMobile:width<800,hasTouch:width<800});
                let records = [{...component,name:'ESP32 development board',model:'ESP32-S3',notes:'Existing notes'},
                    {...component,id:'second',inventory_number:'INV-000002',name:'ESP32 C3 module',model:'ESP32-C3',quantity:4}];
                let uploads = 0, writes = 0, checks = 0;
                await page.route('**/api/**',async route => {
                    const request = route.request(),url = new URL(request.url());
                    if(url.pathname==='/api/events')return route.fulfill({contentType:'text/event-stream',body:'retry: 3000\n\n'});
                    if(url.pathname==='/api/components/similar'){
                        checks++;return route.fulfill({json:{matches:[{...records[0],similarity_reason:'Same model / part number'}]}});
                    }
                    if(url.pathname==='/api/upload'){
                        uploads++;return route.fulfill({json:{image:'/uploads/new-front.png'}});
                    }
                    if(url.pathname==='/api/components'&&request.method()==='POST'){
                        writes++;assert.equal(url.searchParams.get('allow_similar'),'true');
                        records.push({...request.postDataJSON(),id:'third',inventory_number:'INV-000003'});
                        return route.fulfill({status:201,json:records.at(-1)});
                    }
                    return route.fulfill({json:url.pathname==='/api/components'?records:
                        {types:records.length,units:5,low_stock:1,categories:['Boards'],locations:['A']}});
                });
                await page.goto(fixture.url);
                await page.locator('.compare-choice input').nth(1).waitFor();
                await page.locator('.compare-choice input').nth(0).check();
                await page.locator('.compare-choice input').nth(1).check();
                await page.locator('#compareSelected').click();
                await page.locator('#comparisonOverlay').waitFor({state:'visible'});
                assert.match(await page.locator('#comparisonContent').innerText(),/INV-000001/);
                assert.match(await page.locator('#comparisonContent').innerText(),/INV-000002/);
                assert.ok(await page.locator('.comparison-different').count());
                await assertFits(page,'comparison');
                records[1].quantity=7;
                await page.evaluate(()=>refresh());
                assert.match(await page.locator('#comparisonContent').innerText(),/7/);
                await page.getByRole('button',{name:'Back',exact:true}).click();
                await page.getByRole('button',{name:/Add component/}).click();
                await page.locator('[name=name]').fill('ESP32 S3 development board');
                await page.locator('[name=model]').fill('ESP32-S3');
                await page.locator('[name=quantity]').fill('3');
                await page.locator('#photo').setInputFiles({name:'front.png',mimeType:'image/png',buffer:png});
                await page.getByRole('button',{name:'Save component',exact:true}).click();
                await page.locator('#similarWarning').waitFor({state:'visible'});
                assert.equal(uploads,0);assert.equal(writes,0);
                await page.getByRole('button',{name:'Compare with draft',exact:true}).click();
                await page.locator('#comparisonOverlay').waitFor({state:'visible'});
                assert.match(await page.locator('#comparisonContent').innerText(),/Unsaved component/);
                await assertFits(page,'comparison');
                if(process.env.LAYOUT_SCREENSHOTS&&width===390)
                    await page.screenshot({path:path.join(process.env.LAYOUT_SCREENSHOTS,name+'-compare.png')});
                await page.keyboard.press('Escape');
                assert.equal(await page.locator('[name=name]').inputValue(),'ESP32 S3 development board');
                await page.locator('[name=name]').fill('ESP32 family variant');
                await page.getByRole('button',{name:'Save separately anyway',exact:true}).click();
                await page.waitForFunction(() => !document.getElementById('saveBtn').disabled);
                assert.equal(checks,2);assert.equal(writes,0);
                await page.getByRole('button',{name:'Save separately anyway',exact:true}).click();
                await page.locator('#overlay').waitFor({state:'hidden'});
                assert.equal(writes,1);assert.equal(uploads,1);
                assert.equal(records[0].quantity,1);
                assert.equal(records.at(-1).inventory_number,'INV-000003');
                await page.close();
            }
        } finally {
            if(browser)await browser.close();
            await new Promise(resolve=>fixture.server.close(resolve));
        }
    });

    test(name + ': broad typo-tolerant search and reciprocal similarity links', async () => {
        const fixture=await fixtureServer();let browser;
        try{
            browser=await engine.launch({headless:true});
            const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
            const records=[
                {...component,id:'one',inventory_number:'INV-000001',name:'Light Detector',category:'Sensor Module',model:'LD-1',notes:'Photoresistor module',vendor:'Amazon',location:'A'},
                {...component,id:'two',inventory_number:'INV-000002',name:'Optical Detector',category:'Photo Sensor',model:'OD-2',notes:'Photodiode sensor',vendor:'Mouser',location:'B'},
                {...component,id:'three',inventory_number:'INV-000003',name:'Voltage Regulator',category:'Power',model:'VR-24',notes:'Switching power supply',vendor:'Digi-Key',location:'C'}];
            const links={one:[{id:'two',name:records[1].name,inventory_number:'INV-000002'}],
                two:[{id:'one',name:records[0].name,inventory_number:'INV-000001'}],three:[]};
            await page.route('**/api/**',route=>{
                const endpoint=new URL(route.request().url()).pathname;
                if(endpoint==='/api/events')return route.fulfill({contentType:'text/event-stream',body:'retry: 3000\n\n'});
                return route.fulfill({json:endpoint==='/api/components'?records:endpoint==='/api/components/relationships'?links:
                    {types:3,units:3,low_stock:3,categories:['Sensor Module','Photo Sensor','Power'],locations:['A','B','C']}});
            });
            await page.goto(fixture.url);await page.locator('.component').nth(2).waitFor();
            assert.equal(await page.locator('.similarity-links').count(),2);
            await page.locator('.similarity-links summary').nth(0).click();
            const forward=page.locator('.similarity-links a[href="#component=two"]');
            assert.match(await forward.innerText(),/INV-000002/);
            await forward.click();await page.locator('#overlay').waitFor({state:'visible'});
            assert.equal(await page.locator('#inventoryNumber').innerText(),'INV-000002');
            await page.getByRole('button',{name:'Cancel',exact:true}).click();
            await page.locator('.similarity-links summary').nth(1).click();
            await page.locator('.similarity-links a[href="#component=one"]').click();
            await page.locator('#overlay').waitFor({state:'visible'});
            assert.equal(await page.locator('#inventoryNumber').innerText(),'INV-000001');
            await page.getByRole('button',{name:'Cancel',exact:true}).click();
            for(const [query,count] of [['photo',2],['phoot',2],['phto',2],['Amaz',1],['Amzon',1],['photo mouser',1]]){
                await page.locator('#search').fill(query);
                assert.equal(await page.locator('.component').count(),count,query);
                await assertFits(page);
            }
            await page.goto(fixture.url+'/#component=two');
            await page.locator('#overlay').waitFor({state:'visible'});
            assert.equal(await page.locator('#inventoryNumber').innerText(),'INV-000002');
            await assertFits(page,true);
        }finally{
            if(browser)await browser.close();
            await new Promise(resolve=>fixture.server.close(resolve));
        }
    });
}

for(const [name,engine] of Object.entries({chromium,webkit})){
    test(name+': selected AI reviews require explicit approval and fit phone screens',async()=>{
        const fixture=await fixtureServer();let browser;
        try{
            browser=await engine.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:844}});
            const errors=[];page.on('pageerror',e=>errors.push(e.message));
            const records=Array.from({length:9},(_,i)=>({...component,id:'review-'+i,inventory_number:'INV-'+String(i+1).padStart(6,'0'),
                name:i===0?'<img src=x onerror="window.injection=true">':'Fixture sensor '+i}));
            let review,requests=0,applies=0;
            await page.route('**/api/**',async route=>{
                const request=route.request(),path=new URL(request.url()).pathname;
                if(path==='/api/events')return route.fulfill({contentType:'text/event-stream',body:'retry: 3000\n\n'});
                if(path==='/api/similarity-reviews'&&request.method()==='POST'){
                    requests++;const body=request.postDataJSON();assert.equal(body.component_ids.length,2);assert.equal(body.provider,'both');
                    assert.deepEqual(Object.keys(body).sort(),['component_ids','provider']);
                    review={id:'saved-fixture',created_at:'2026-11-11T20:00:00Z',components:records.slice(0,2),
                        pairs:[{pair_id:'P01',left:records[0],right:records[1]}],providers:[
                            {provider:'claude',model:'fixture-claude',status:'success',results:[{pair_id:'P01',verdict:'different_components',confidence:'high',
                                reason:'Different sensing functions. '.repeat(40),differences:'Tilt versus magnetic',evidence_needed:'Check markings'}]},
                            {provider:'openai',model:'fixture-openai',status:'error',error:'Provider returned HTTP 429',results:[]}]};
                    return route.fulfill({json:review});
                }
                if(path.endsWith('/apply')){
                    applies++;assert.deepEqual(request.postDataJSON(),{choices:[{pair_id:'P01',verdict:'different_components'}]});
                    if(applies===1)return route.fulfill({status:409,json:{detail:'Component metadata changed. Run a fresh review before applying decisions.'}});
                    return route.fulfill({json:{applied:1}});
                }
                if(path==='/api/similarity-reviews')return route.fulfill({json:review?[{id:review.id,created_at:review.created_at,component_count:2}]:[]});
                if(path==='/api/similarity-reviews/saved-fixture')return route.fulfill({json:review});
                return route.fulfill({json:path==='/api/components'?records:path==='/api/components/relationships'?{}:
                    {types:9,units:9,low_stock:9,categories:[component.category],locations:[]}});
            });
            await page.goto(fixture.url);await page.locator('.component').nth(8).waitFor();
            await page.locator('#openReviewButton').click();await page.locator('#reviewOverlay').waitFor({state:'visible'});
            assert.equal(requests,0);assert.equal(await page.locator('#runReview').isDisabled(),true);
            for(let i=0;i<8;i++)await page.locator('#reviewComponents input').nth(i).check();
            await page.locator('#reviewComponents input').nth(8).click();
            assert.equal(await page.locator('#reviewComponents input:checked').count(),8);
            assert.match(await page.locator('#reviewStatus').innerText(),/at most 8/);
            for(let i=2;i<8;i++)await page.locator('#reviewComponents input').nth(i).uncheck();
            await page.locator('#reviewSearch').fill('Fixture');await page.locator('#reviewSearch').fill('');
            assert.equal(await page.locator('#reviewComponents input:checked').count(),2);
            await page.locator('#runReview').click();await page.locator('.review-pair').waitFor();
            assert.equal(requests,1);assert.equal(applies,0);assert.equal(await page.evaluate(()=>window.injection),undefined);
            assert.match(await page.locator('#reviewResults').innerText(),/HTTP 429/);
            assert.equal(await page.locator('input[data-apply-pair]:checked').count(),0);
            await page.locator('#applyReview').click();assert.equal(applies,0);
            await page.locator('input[data-apply-pair]').check();await page.locator('#applyReview').click();assert.equal(applies,0);
            await page.locator('select[data-pair]').selectOption('different_components');await page.locator('#applyReview').click();
            await page.waitForFunction(()=>document.getElementById('reviewStatus').textContent.includes('fresh review'));
            assert.equal(applies,1);
            await page.locator('#applyReview').click();await page.waitForFunction(()=>document.getElementById('reviewStatus').textContent.includes('Applied 1'));
            assert.equal(applies,2);
            assert.match(await page.getByRole('link',{name:'Download HTML review report'}).getAttribute('href'),/saved-fixture\/report$/);
            for(const width of [320,390,844]){
                await page.setViewportSize({width,height:844});
                const fits=await page.locator('.review-modal').evaluate(e=>({client:e.clientWidth,scroll:e.scrollWidth,page:document.documentElement.scrollWidth,width:innerWidth}));
                assert.ok(fits.scroll<=fits.client+1&&fits.page<=fits.width+1,JSON.stringify(fits));
            }
            await page.keyboard.press('Escape');assert.equal(await page.locator('#reviewOverlay').isVisible(),false);
            assert.deepEqual(errors,[]);
        }finally{if(browser)await browser.close();await new Promise(resolve=>fixture.server.close(resolve))}
    });
}

for(const [name,engine] of Object.entries({chromium,webkit})){
    test(name+': varying card content keeps stock and comparison controls aligned',async()=>{
        const fixture=await fixtureServer();let browser;
        try{
            browser=await engine.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
            const rows=Array.from({length:4},(_,i)=>({...component,id:'aligned-'+i,inventory_number:'INV-00000'+(i+1),
                name:i===1?'Long descriptive sensor module with several identifying features '.repeat(3):'Short sensor',
                category:i===2?'Sensor / Motion Detection (Passive Infrared)':'Sensor Module',model:'Model',location:'A',quantity:i+1}));
            await page.route('**/api/**',route=>{
                const path=new URL(route.request().url()).pathname;
                if(path==='/api/events')return route.fulfill({contentType:'text/event-stream',body:'retry: 3000\n\n'});
                return route.fulfill({json:path==='/api/components'?rows:path==='/api/components/relationships'?{
                    'aligned-0':[{id:'aligned-2',inventory_number:'INV-000003',name:rows[2].name,reason:'Reviewed: Related but distinct'}]}:
                    {types:4,units:10,low_stock:1,categories:['Sensor Module'],locations:['A']}});
            });
            await page.goto(fixture.url);await page.locator('.component').nth(3).waitFor();
            for(const width of [1440,1024,768,390]){
                await page.setViewportSize({width,height:1000});
                for(const expanded of [false,true]){
                    await page.locator('.similarity-links').evaluate((e,open)=>{e.open=open},expanded);
                    const metrics=await page.locator('.component').evaluateAll(cards=>cards.map(c=>({
                        top:c.getBoundingClientRect().top,height:c.getBoundingClientRect().height,
                        stock:c.querySelector('.bottom').getBoundingClientRect().top,
                        compare:c.querySelector('.compare-choice').getBoundingClientRect().top
                    })));
                    for(const left of metrics)for(const right of metrics)if(Math.abs(left.top-right.top)<1){
                        assert.ok(Math.abs(left.height-right.height)<1,JSON.stringify(metrics));
                        assert.ok(Math.abs(left.stock-right.stock)<1,JSON.stringify(metrics));
                        assert.ok(Math.abs(left.compare-right.compare)<1,JSON.stringify(metrics));
                    }
                    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
                }
            }
        }finally{if(browser)await browser.close();await new Promise(resolve=>fixture.server.close(resolve))}
    });
}

for(const [name,engine] of Object.entries({chromium,webkit})){
    test(name+': build footer and release history work on phones and fail independently of inventory',async()=>{
        const fixture=await fixtureServer();let browser;
        try{
            browser=await engine.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:844}});
            const errors=[];page.on('pageerror',e=>errors.push(e.message));
            const releases=JSON.parse(await fs.readFile(path.join(root,'release-notes.json'),'utf8'));
            releases[0].changes.push('<script>window.releaseInjection=true</script>');
            const number=releases[0].build_number;let buildFails=false,historyFails=false;
            await page.route('**/api/**',route=>{
                const path=new URL(route.request().url()).pathname;
                if(path==='/api/build')return buildFails?route.fulfill({status:503,json:{detail:'unavailable'}}):
                    route.fulfill({json:{build_number:number,label:'Build '+number,release_notes_url:'/release-notes'}});
                if(path==='/api/releases')return historyFails?route.fulfill({status:503,json:{detail:'unavailable'}}):route.fulfill({json:releases});
                if(path==='/api/events')return route.fulfill({contentType:'text/event-stream',body:'retry: 3000\n\n'});
                return route.fulfill({json:path==='/api/components'?[component]:path==='/api/components/relationships'?{}:
                    {types:1,units:1,low_stock:1,categories:[component.category],locations:[]}});
            });
            await page.goto(fixture.url);await page.locator('.component').waitFor();
            await page.waitForFunction(n=>document.getElementById('buildInfo').textContent==='Build '+n+' · Release notes',number);
            for(const width of [320,390,1440]){
                await page.setViewportSize({width,height:844});await page.locator('#buildInfo').scrollIntoViewIfNeeded();
                assert.ok(await page.locator('#buildInfo').isVisible());
                assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
            }
            await page.locator('#buildInfo').click();await page.locator('.release-entry').nth(releases.length-1).waitFor();
            assert.match(await page.locator('.release-entry h2').first().innerText(),new RegExp('Build '+number));
            assert.match(await page.locator('#releases').innerText(),/Legacy build 721e296/);
            assert.equal(await page.evaluate(()=>window.releaseInjection),undefined);
            await page.setViewportSize({width:320,height:844});
            assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
            historyFails=true;await page.reload();await page.waitForFunction(()=>document.getElementById('releaseStatus').textContent.includes('unavailable'));
            assert.ok(await page.getByRole('link',{name:'Back to inventory'}).isVisible());
            buildFails=true;await page.goto(fixture.url);await page.locator('.component').waitFor();
            await page.waitForFunction(()=>document.getElementById('buildInfo').textContent.includes('unavailable'));
            assert.equal(await page.locator('#types').innerText(),'1');assert.deepEqual(errors,[]);
        }finally{if(browser)await browser.close();await new Promise(resolve=>fixture.server.close(resolve))}
    });
}
