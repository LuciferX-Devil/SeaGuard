import assert from 'node:assert/strict';
import fs from 'node:fs';
import ex from '../src/rescue/exercise.cjs';
const rows=[];
function test(name,fn){try{fn();rows.push({name,passed:true});}catch(e){rows.push({name,passed:false,error:e.message});}}
function advance(w,predicate,max=1200){for(let i=0;i<max;i++){if(predicate())return;ex.step(w.state,w.ex,{realDeltaS:1});}throw Error('exercise deadline');}
test('pre-start replacement rejects atomically rather than creating a stuck countdown',()=>{
 const w=ex.createExercise(),before=JSON.stringify(w);assert.throws(()=>ex.recharge(w.state,w.ex,{teamId:'T1'}),/start/i);assert.equal(JSON.stringify(w),before);
});
test('replacement after completion resumes, runs exactly 60 seconds and pauses again',()=>{
 const w=ex.createExercise();ex.start(w.state,w.ex,{scenario:'MAN_OVERBOARD'});ex.setSpeed(w.state,w.ex,{speed:20});ex.dispatch(w.state,w.ex,{teamId:'T2',personnel:6,recoveryKit:true});
 advance(w,()=>w.state.incidents[w.ex.incidentId].status==='RESOLVED');ex.command(w.state,w.ex,{teamId:'T2',action:'RETURN'});advance(w,()=>ex.view(w.state,w.ex).allClear);
 assert.equal(w.ex.paused,true);ex.setSpeed(w.state,w.ex,{speed:1});w.state.teams[1].pumpBattery.chargeWh=0;
 ex.recharge(w.state,w.ex,{teamId:'T2'});assert.equal(w.ex.paused,false);const t=w.ex.simTime;
 for(let i=0;i<59;i++)ex.step(w.state,w.ex,{realDeltaS:1});assert.equal(w.state.teams[1].pumpBattery.chargeWh,0);assert.equal(w.ex.paused,false);
 ex.step(w.state,w.ex,{realDeltaS:1});assert.equal(w.state.teams[1].pumpBattery.chargeWh,20);assert.equal(w.ex.simTime,t+60);assert.equal(w.ex.paused,true);
 assert.ok(w.ex.timeline.some(e=>e.kind==='RECHARGE_COMPLETE'));ex.step(w.state,w.ex,{realDeltaS:1});assert.equal(w.ex.simTime,t+60);
});
for(const r of rows)console.log(`${r.passed?'PASS':'FAIL'} ${r.name}${r.error?': '+r.error:''}`);
fs.writeFileSync(new URL('../reports/rescue-battery-controller.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),rows},null,2));
if(rows.some(r=>!r.passed))process.exitCode=1;
