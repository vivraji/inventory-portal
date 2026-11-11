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
        const file = pathname === '/' ? path.join(root,'index.html') : path.resolve(root,'.' + pathname.replace(/^\/static/,''));
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
}
