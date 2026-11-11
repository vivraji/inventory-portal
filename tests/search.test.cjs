const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(fs.readFileSync('static/search.js','utf8'),context);
test('all metadata, prefixes and common typos match the shared API search contract',()=>{
    const cases=JSON.parse(fs.readFileSync('tests/search-cases.json','utf8'));
    for(const {record,queries} of cases)
        for(const [query,expected] of Object.entries(queries))
            assert.equal(context.componentMatchesSearch(record,query),expected,JSON.stringify({record,query}));
});
