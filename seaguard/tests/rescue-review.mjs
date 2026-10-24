import assert from 'node:assert/strict';
import fs from 'node:fs';
import model from '../src/rescue/model.cjs';
import exercise from '../src/rescue/exercise.cjs';
import persistence from '../src/rescue/persistence.cjs';
const rows=[];
function test(name, fn){try{fn();rows.push({name,passed:true});}catch(e){rows.push({name,passed:false,error:e.message});}}
function world(){const w=exercise.createExercise();exercise.start(w.state,w.ex,{scenario:'FLOODING'});return w;}
function harness(){const flowValues=new Map(),ctx=new Map(),flow={get:k=>flowValues.get(k),set:(k,v)=>flowValues.set(k,v)};
 const run=new Function('msg','global','flow','context',fs.readFileSync('seaguard/src/functions/fnRescue.js','utf8'));
 return {flow,call:msg=>run(msg,{get:k=>k==='rescue'?exercise:undefined},flow,{get:k=>ctx.get(k),set:(k,v)=>ctx.set(k,v)})};}
test('old samples do not become fresh when delivered later',()=>{const w=world();model.tick(w.state,50);assert.equal(model.sensorReport(w.state,{incidentId:w.ex.incidentId,kind:'WATER_LEVEL',value:0,sampleAt:0}),false);assert.equal(w.state.incidents[w.ex.incidentId].lastWater,null);});
test('future samples reject atomically and older reports cannot overwrite new ones',()=>{const w=world();model.tick(w.state,10);const before=JSON.stringify(w.state);assert.throws(()=>model.sensorReport(w.state,{incidentId:w.ex.incidentId,kind:'WATER_LEVEL',value:0,sampleAt:11}));assert.equal(JSON.stringify(w.state),before);model.sensorReport(w.state,{incidentId:w.ex.incidentId,kind:'WATER_LEVEL',value:80,sampleAt:9});model.sensorReport(w.state,{incidentId:w.ex.incidentId,kind:'WATER_LEVEL',value:0,sampleAt:8});assert.equal(w.state.incidents[w.ex.incidentId].lastWater.value,80);});
for(const [name,mutate] of [
 ['inconsistent personnel reservation',s=>s.teams[0].personnelAssigned=0],
 ['inconsistent recovery kit reservation',s=>s.shared.recoveryKitsAvailable=1],
 ['reused mission counter',s=>s.counters.mission=0],
 ['duplicate mission IDs',s=>s.missions.push(structuredClone(s.missions[0]))],
 ['inconsistent team status',s=>s.teams[0].status='IDLE']
])test('checkpoint rejects '+name,()=>{const w=world();exercise.dispatch(w.state,w.ex,{teamId:'T1',personnel:2,recoveryKit:true});mutate(w.state);assert.ok(persistence.validateSnapshot(persistence.buildSnapshot(w)));});
test('dashboard keeps one shared world without a persistence service',()=>{const h=harness();h.call({topic:'cmd',payload:{action:'start',scenario:'MAN_OVERBOARD'}});h.call({topic:'tick',realDeltaS:1});assert.equal(h.flow.get('rescueWorld').ex.simTime,1);});
test('map reconnect replays geographical layers without advancing time',()=>{const h=harness();h.call({topic:'cmd',payload:{action:'start',scenario:'FLOODING'}});const before=h.flow.get('rescueWorld').ex.simTime;const r=h.call({payload:{action:'connected'}});assert.ok(r[1].some(m=>m.payload.command?.layer==='OSM'));assert.equal(h.flow.get('rescueWorld').ex.simTime,before);});
test('reset clears old markers and route completion deletes the named route',()=>{const h=harness();h.call({topic:'cmd',payload:{action:'start',scenario:'MAN_OVERBOARD'}});h.call({topic:'cmd',payload:{action:'dispatch',teamId:'T1',personnel:2,recoveryKit:true}});const r=h.call({topic:'tick',realDeltaS:20});assert.ok(r[1].some(m=>m.payload.name==='T1 route'));const s=h.flow.get('rescueWorld');const messages=h.call({topic:'tick',realDeltaS:300})[1];assert.ok(messages.some(m=>m.payload.name==='T1 route' && m.payload.deleted));assert.ok(s.state.missions[0].arrivedAt!==null);const reset=h.call({topic:'cmd',payload:{action:'reset'}});assert.ok(reset[1].some(m=>m.payload.command?.clearlayer));});
test('return ETA is finite after a return command executes',()=>{const w=world();exercise.dispatch(w.state,w.ex,{teamId:'T1',personnel:2,recoveryKit:true});exercise.step(w.state,w.ex,{realDeltaS:100});exercise.command(w.state,w.ex,{teamId:'T1',action:'RETURN'});exercise.step(w.state,w.ex,{realDeltaS:10});const v=exercise.view(w.state,w.ex);assert.equal(v.missions[0].status,'RETURNING');assert.ok(Number.isFinite(v.missions[0].etaS));});
test('completed exercise pauses automatically and reset starts a fresh event timeline',()=>{
 const w=exercise.createExercise();exercise.start(w.state,w.ex,{scenario:'MAN_OVERBOARD'});exercise.dispatch(w.state,w.ex,{teamId:'T2',personnel:6,recoveryKit:true});
 const until=p=>{for(let i=0;i<300;i++){if(p(exercise.view(w.state,w.ex)))return;exercise.step(w.state,w.ex,{realDeltaS:5});}throw Error('exercise did not reach expected stage');};
 until(v=>v.incident.status==='RESOLVED');exercise.command(w.state,w.ex,{teamId:'T2',action:'RETURN'});until(v=>v.allClear);
 assert.equal(w.ex.paused,true);const time=w.ex.simTime;exercise.step(w.state,w.ex,{realDeltaS:100});assert.equal(w.ex.simTime,time);
 exercise.reset(w.state,w.ex);exercise.start(w.state,w.ex,{scenario:'MAN_OVERBOARD'});exercise.dispatch(w.state,w.ex,{teamId:'T1',personnel:2,recoveryKit:true});exercise.step(w.state,w.ex,{realDeltaS:300});
 assert.ok(w.ex.timeline.some(e=>e.kind==='ARRIVED'));assert.equal(w.ex.restoredFromSnapshot,false);
});
fs.writeFileSync('seaguard/reports/rescue-review.json',JSON.stringify({at:new Date().toISOString(),tests:rows},null,2));
rows.forEach(r=>console.log(`${r.passed?'PASS':'FAIL'} ${r.name}${r.error?': '+r.error:''}`));
process.exitCode=rows.some(r=>!r.passed)?1:0;
