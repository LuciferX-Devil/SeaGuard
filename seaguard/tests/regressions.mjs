import fs from 'node:fs';
import assert from 'node:assert/strict';
const values=new Map([['epoch',1],['simTime',10]]);
const global={get:k=>values.get(k),set:(k,v)=>values.set(k,v)};
const node={status(){},warn(){},error(){}};
function invoke(id,msg={},contextValues=new Map()){
 const code=fs.readFileSync(`seaguard/src/functions/${id}.js`,'utf8');
 return new Function('msg','node','context','global','flow','env',code)(msg,node,{get:k=>contextValues.get(k),set:(k,v)=>contextValues.set(k,v)},global,{}, {get:()=>undefined});
}
invoke('fn0002');
const outcomes=[];
function test(name,fn){try{fn();outcomes.push({name,passed:true});}catch(e){outcomes.push({name,passed:false,error:e.message});}}
const campaign=q=>invoke('fn0047',{req:{query:q}});
const sync=p=>invoke('fn002e',{payload:p});
const record=(s,lat=9)=>({s,t:s,lat,lon:79});
test('seed zero remains replayable in campaign status',()=>{values.set('test',{seed:0,state:'DONE'});assert.equal(invoke('fn004a').payload.seed,0);});
test('invalid seed rejected without emitting a run command',()=>{const result=campaign({seed:'not-a-number'});assert.equal(result[0],null);assert.equal(result[1].statusCode,400);});
test('out of range seed rejected',()=>assert.equal(campaign({seed:'4294967296'})[1].statusCode,400));
test('fractional seed rejected',()=>assert.equal(campaign({seed:'1.5'})[1].statusCode,400));
test('negative speed rejected',()=>assert.equal(campaign({seed:'42',speed:'-1'})[1].statusCode,400));
test('non-finite speed rejected',()=>assert.equal(campaign({seed:'42',speed:'Infinity'})[1].statusCode,400));
test('valid zero seed emits the same seed',()=>assert.equal(campaign({seed:'0',speed:'20'})[0].payload.seed,0));
test('running campaigns cannot be overwritten by a second API start',()=>{values.set('test',{state:'RUNNING',seed:42});const result=campaign({seed:'7'});assert.equal(result[1].statusCode,409);assert.equal(result[0],null);values.set('test',{});});
test('sync rejects unknown boat before touching storage',()=>{values.set('syncStore',{});assert.equal(sync({boat:'__proto__',ep:1,records:[record(1)]}).statusCode,400);assert.deepEqual(values.get('syncStore'),{});});
test('sync validates entire batch atomically',()=>{values.set('syncStore',{});assert.equal(sync({boat:'B1',ep:1,records:[record(1),record(-2)]}).statusCode,400);assert.deepEqual(values.get('syncStore'),{});});
test('sync rejects out of range coordinates',()=>assert.equal(sync({boat:'B1',ep:1,records:[record(1,100)]}).statusCode,400));
test('sync rejects non-array record collections',()=>assert.equal(sync({boat:'B1',ep:1,records:{a:record(1)}}).statusCode,400));
test('sync rejects oversized batches',()=>assert.equal(sync({boat:'B1',ep:1,records:Array.from({length:51},(_,i)=>record(i+1))}).statusCode,400));
test('sync stale epoch returns conflict without storage mutation',()=>{values.set('syncStore',{});assert.equal(sync({boat:'B1',ep:0,records:[record(1)]}).statusCode,409);assert.deepEqual(values.get('syncStore'),{});});
test('sync absorbs a repeated batch once and acknowledges a gap only when filled',()=>{values.set('syncStore',{});let r=sync({boat:'B1',ep:1,records:[record(1),record(3)]});assert.equal(r.payload.ackedThrough,1);sync({boat:'B1',ep:1,records:[record(1),record(3)]});r=sync({boat:'B1',ep:1,records:[record(2)]});assert.equal(r.payload.ackedThrough,3);assert.equal(r.payload.stored,3);assert.equal(values.get('syncStore').B1.dupRecords,2);});
test('conflicting retransmission is rejected instead of silently corrupting position',()=>{values.set('syncStore',{});sync({boat:'B1',ep:1,records:[record(1)]});assert.equal(sync({boat:'B1',ep:1,records:[record(1,10)]}).statusCode,409);assert.equal(values.get('syncStore').B1.recs[1].lat,9);});
test('shore rejects malformed sequence before accounting loop',()=>{const out=invoke('fn001d',{payload:{b:'B1',ep:1,k:'T',s:'bad',t:1,la:9,lo:79}});assert.equal(out,null);});
test('shore rejects unknown vessel identity',()=>{const out=invoke('fn001d',{payload:{b:'__proto__',ep:1,k:'T',s:1,t:1,la:9,lo:79}});assert.equal(out,null);});
test('empty event identity cannot poison the persisted deduplication set',()=>{const c=new Map();const out=invoke('fn001d',{payload:{b:'B1',ep:1,k:'E',s:1,t:1,la:9,lo:79,eid:'',ev:'SOS'}},c);assert.equal(out,null);assert.deepEqual(c.get('S').L,{});});
test('large sequence gaps keep recovery memory bounded',()=>{const c=new Map();invoke('fn001d',{payload:{b:'B1',ep:1,k:'T',s:1000000,t:1,la:9,lo:79}},c);const link=c.get('S').L.B1;assert.ok(link.missing.size<=4000);assert.equal(link.recv+link.lost,link.highest);});
test('duplicates remain harmless after the recent ID cache is evicted',()=>{const c=new Map();invoke('fn001d',{payload:{b:'B1',ep:1,k:'T',s:1,t:1,la:9,lo:79}},c);const link=c.get('S').L.B1;link.highest=5000;link.recv=5000;link.lost=0;link.seen.clear();link.seenQ=[];invoke('fn001d',{payload:{b:'B1',ep:1,k:'T',s:1,t:1,la:9,lo:79}},c);assert.equal(link.recv,5000);assert.equal(link.dup,1);assert.equal(link.recv+link.lost,link.highest);});
test('an acknowledgement outside the sent log range cannot erase onboard records',()=>{const state={ep:1,boats:{B1:{id:'B1',acked:0,logSeq:2,log:[record(1),record(2)],inflight:{from:1,to:2},stats:{syncErrors:0,pending:[]},pending:[]}}};invoke('fn0006',{topic:'syncResp',boat:'B1',ep:1,statusCode:200,payload:{ackedThrough:999}},new Map([['S',state]]));assert.equal(state.boats.B1.acked,0);assert.equal(state.boats.B1.log.length,2);});
test('test alerts created in the same paused second have unique response IDs',()=>{const c=new Map();invoke('fn0029',{topic:'test'},c);invoke('fn0029',{topic:'test'},c);const rows=c.get('S').list;assert.equal(rows.length,2);assert.notEqual(rows[0].id,rows[1].id);});
test('notification timeouts obey the retry limit instead of retrying forever',()=>{values.set('simTime',100);const rec={inflight:true,sentAt:0,attempts:15,status:'SENDING'};invoke('fn0029',{topic:'tick'},new Map([['S',{ep:1,list:[rec]}]]));assert.equal(rec.status,'FAILED');assert.equal(rec.attempts,15);});
function firmwareSequence(readings){const c=new Map();const packets=[];for(let i=0;i<readings.length;i++){values.set('simTime',i+1);const r={ep:1,boat:'B1',t:i+1,ble:[],gps:{lat:9,lon:79,spd:0,hdg:0,hdop:1},imu:{roll:0},water:{level:2},bat:{v:12.6},inHarbour:false,...readings[i]};const result=invoke('fn0006',{topic:'reading',payload:r},c);packets.push(...(result?.[0]??[]));}return {events:packets.filter(p=>p.payload.k==='E').map(p=>p.payload),state:c.get('S').boats.B1};}
test('capsize is debounced and latched instead of alarming every sample',()=>{const r=firmwareSequence(Array.from({length:5},()=>({imu:{roll:80}})));assert.equal(r.events.filter(e=>e.ev==='CAPSIZE').length,1);assert.equal(r.events[0].t,4);});
test('a short wave roll is filtered without a capsize event',()=>{const r=firmwareSequence([{imu:{roll:80}},{imu:{roll:80}},{imu:{roll:0}}]);assert.equal(r.events.length,0);assert.equal(r.state.stats.filtered.roll,1);});
test('flooding needs three sustained high-water samples',()=>{const r=firmwareSequence(Array.from({length:3},()=>({water:{level:80}})));assert.equal(r.events.filter(e=>e.ev==='FLOODING').length,1);assert.equal(r.events[0].t,3);});
test('crew tag loss alarms at eight samples, not before',()=>{const r=firmwareSequence(Array.from({length:8},()=>({ble:[{tag:'T1',name:'Demo crew',rssi:-100}]})));assert.equal(r.events.filter(e=>e.ev==='MOB').length,1);assert.equal(r.events[0].t,8);});
test('a late telemetry position never overwrites a newer fix',()=>{const c=new Map();invoke('fn001d',{payload:{b:'B1',ep:1,k:'T',s:2,t:2,la:9.2,lo:79}},c);invoke('fn001d',{payload:{b:'B1',ep:1,k:'T',s:1,t:1,la:9.1,lo:79}},c);assert.equal(values.get('fleet').B1.lat,9.2);assert.equal(c.get('S').L.B1.staleRejected,1);});
fs.writeFileSync('seaguard/reports/regressions.json',JSON.stringify({at:new Date().toISOString(),tests:outcomes},null,2));
for(const r of outcomes)console.log(`${r.passed?'PASS':'FAIL'} ${r.name}${r.error?': '+r.error.split('\n')[0]:''}`);
console.log(`${outcomes.filter(r=>r.passed).length}/${outcomes.length} regression scenarios passed`);process.exitCode=outcomes.some(r=>!r.passed)?1:0;
