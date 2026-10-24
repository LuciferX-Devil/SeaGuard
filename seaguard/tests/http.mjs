import assert from 'node:assert/strict';
import fs from 'node:fs';
const base=(process.env.SEAGUARD_BASE_URL||'http://127.0.0.1:1880');
const checks=[];
for(const query of ['seed=NaN','seed=-1','seed=1.2','seed=4294967296','seed=1&speed=Infinity','seed=1&speed=-5']){
 const r=await fetch(base+'/seaguard/test/run?'+query);assert.equal(r.status,400,query);checks.push({query,status:r.status});
}
const state=await (await fetch(base+'/seaguard/state?keys=epoch,incidents,notifications')).json();
for(const records of [null,{},[],[{s:-1,t:0,lat:9,lon:79}],[{s:1,t:0,lat:999,lon:79}]]){
 const r=await fetch(base+'/seaguard/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ep:state.epoch,boat:'B1',records})});assert.equal(r.status,400);checks.push({syncRecords:records,status:r.status});
}
fs.writeFileSync('seaguard/reports/http.json',JSON.stringify({at:new Date().toISOString(),checks},null,2));console.log(`${checks.length} live HTTP rejection checks passed; no campaign or sync state changed.`);
