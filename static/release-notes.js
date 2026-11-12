(async () => {
    const status = document.getElementById('releaseStatus');
    const element = (tag,text) => {const node=document.createElement(tag);node.textContent=text;return node};
    try {
        const response=await fetch('/api/releases',{cache:'no-store',signal:AbortSignal.timeout(10000)});
        if(!response.ok)throw Error('Release history unavailable');
        const releases=await response.json();
        if(!Array.isArray(releases)||!releases.length)throw Error('Invalid release history');
        const root=document.getElementById('releases');
        for(const release of releases){
            const label=release.build_number===null?'Legacy build '+release.commit:'Build '+release.build_number;
            const section=element('section','');section.className='release-entry';
            section.append(element('h2',label+' · '+release.title),element('p',release.date));
            const list=element('ul','');for(const change of release.changes)list.append(element('li',change));
            section.append(list);root.append(section);
        }
        status.textContent='Latest source build: '+releases[0].build_number;
    }catch{
        status.textContent='Release history is unavailable. Reload this page to try again.';
    }
})();
