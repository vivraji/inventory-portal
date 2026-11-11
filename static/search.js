function searchText(value) {
    return String(value).toLowerCase().normalize('NFKD').replace(/\p{M}/gu,'');
}
function nearWord(left, right, limit) {
    left=Array.from(left);right=Array.from(right);
    if(Math.abs(left.length-right.length)>limit)return false;
    let previous=Array.from({length:right.length+1},(_,i)=>i),earlier;
    for(let i=1;i<=left.length;i++){
        const current=[i];
        for(let j=1;j<=right.length;j++){
            let cost=Math.min(current[j-1]+1,previous[j]+1,previous[j-1]+(left[i-1]!==right[j-1]?1:0));
            if(earlier&&i>1&&j>1&&left[i-1]===right[j-2]&&left[i-2]===right[j-1])cost=Math.min(cost,earlier[j-2]+1);
            current.push(cost);
        }
        if(Math.min(...current)>limit)return false;
        earlier=previous;previous=current;
    }
    return previous.at(-1)<=limit;
}
function componentMatchesSearch(component, query) {
    const text=searchText(Object.entries(component).filter(([key,value])=>
        !['image','image_back'].includes(key)&&['string','number'].includes(typeof value)).map(([,value])=>String(value)).join(' '));
    query=searchText(query).trim();
    if(!query||text.includes(query))return true;
    if(query.includes('=')||query.includes(';'))return false;
    const terms=query.match(/[\p{L}\p{N}_]+/gu)||[];
    if(!terms.length)return false;
    const words=(text.match(/[\p{L}\p{N}_]+/gu)||[]).filter(word=>Array.from(word).length<=100);
    return terms.every(term=>{
        if(text.includes(term))return true;
        const size=Array.from(term).length;
        if(size<4||size>32||/^\d+$/.test(term))return false;
        const limit=size<8?1:2;
        return words.some(word=>{
            const characters=Array.from(word);
            for(let length=Math.max(1,size-limit);length<=size+limit;length++)
                for(let start=0;start<=characters.length-length;start++)
                    if(nearWord(term,characters.slice(start,start+length).join(''),limit))return true;
            return false;
        });
    });
}
