// Independent battery integration oracles using the existing model API.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import model from '../src/rescue/model.cjs';
const home={lat:9.2876,lon:79.3129},rows=[];
function test(name,fn){try{fn();rows.push({name,passed:true});}catch(error){rows.push({name,passed:false,error:error.message});}}
function near(a,b){assert.ok(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<1e-7,`${a} != ${b}`);}
function fresh(chargeWh=20,capacityWh=20){return model.createState({teams:[{id:'T1',name:'Test',home,capacity:4,personnel:4,pump:{available:true,lpm:25,battery:{capacityWh,chargeWh,drawW:120}},fuelL:120,speedKn:12}]});}
function dispatch(s,id='I1',position=home){model.addIncident(s,{id,kind:'FLOODING',position,crewOnboard:0,initialWaterL:1000,ingressLpm:10});model.dispatch(s,{incidentId:id,teamId:'T1',personnel:2,recoveryKit:false});}
function until(s,p){for(let n=0;n<2000;n++){if(p())return;model.tick(s,1);}throw Error('transition deadline');}
function onScene(s){dispatch(s);until(s,()=>s.teams[0].status==='ON_SCENE');}
function startPump(s){const sent=model.command(s,{incidentId:'I1',teamId:'T1',action:'START_PUMP'});const c=s.commands.find(c=>c.id===sent.id);until(s,()=>c.status==='EXECUTED'||c.status==='FAILED');return c;}
function returnHome(s){model.command(s,{incidentId:'I1',teamId:'T1',action:'RETURN'});until(s,()=>s.teams[0].status==='IDLE');}
test('fractional exhaustion removes only powered litres and stops actual pump',()=>{
 const s=fresh(0.0125);onScene(s);assert.equal(startPump(s).status,'EXECUTED');const before=s.incidents.I1.waterL;
 model.tick(s,0.8);near(s.incidents.I1.waterL,before+10*0.8/60-25*0.375/60);
 assert.equal(s.teams[0].pumpBattery.chargeWh,0);assert.equal(s.teams[0].pumpRunning,false);assert.equal(s.incidents.I1.status,'IN_PROGRESS');
});
test('off, travel and faulted pumps consume no charge',()=>{
 const s=fresh();dispatch(s,'I1',{lat:home.lat+0.1,lon:home.lon});model.tick(s,20);assert.equal(s.teams[0].status,'EN_ROUTE');assert.equal(s.teams[0].pumpBattery.chargeWh,20);
 const q=fresh();onScene(q);model.tick(q,30);assert.equal(q.teams[0].pumpBattery.chargeWh,20);model.setPumpFault(q,{teamId:'T1',fault:true});assert.equal(startPump(q).status,'FAILED');model.tick(q,30);assert.equal(q.teams[0].pumpBattery.chargeWh,20);
});
test('empty START fails at execution without pumping or confirmation',()=>{
 const s=fresh(0);onScene(s);const c=startPump(s);assert.equal(c.status,'FAILED');assert.match(c.failReason,/battery depleted/);const before=s.incidents.I1.waterL;model.tick(s,60);near(s.incidents.I1.waterL,before+10);assert.equal(c.confirmedAt,null);
});
test('fault stops actual running feedback and needs a new start after repair',()=>{
 const s=fresh();onScene(s);startPump(s);model.tick(s,2);model.setPumpFault(s,{teamId:'T1',fault:true});
 const charge=s.teams[0].pumpBattery.chargeWh;assert.equal(s.teams[0].pumpRunning,false);model.tick(s,20);assert.equal(s.teams[0].pumpBattery.chargeWh,charge);
 model.setPumpFault(s,{teamId:'T1',fault:false});model.tick(s,20);assert.equal(s.teams[0].pumpRunning,false);assert.equal(s.teams[0].pumpBattery.chargeWh,charge);
});
test('warning and depletion events fire once without tick spam',()=>{
 const s=fresh(0.0125);onScene(s);startPump(s);model.tick(s,20);model.tick(s,20);for(const kind of ['LOW_BATTERY','BATTERY_DEPLETED'])assert.equal(s.events.filter(e=>e.kind===kind).length,1);
});
test('return does not refill; replacement waits full 60 seconds',()=>{
 const s=fresh(0);onScene(s);assert.throws(()=>model.recharge(s,{teamId:'T1'}),/IDLE/);returnHome(s);assert.equal(s.teams[0].pumpBattery.chargeWh,0);
 model.recharge(s,{teamId:'T1'});assert.throws(()=>dispatch(s,'I2'),/recharg/i);model.tick(s,59);assert.equal(s.teams[0].pumpRecharge.remainingS,1);assert.equal(s.teams[0].pumpBattery.chargeWh,0);model.tick(s,1);assert.equal(s.teams[0].pumpRecharge,null);assert.equal(s.teams[0].pumpBattery.chargeWh,20);
});
test('JSON roundtrip retains exhausted battery and partial replacement',()=>{
 const s=fresh(0);model.recharge(s,{teamId:'T1'});model.tick(s,25);const r=JSON.parse(JSON.stringify(s));assert.equal(r.teams[0].pumpRecharge.remainingS,35);model.tick(r,34);assert.equal(r.teams[0].pumpBattery.chargeWh,0);model.tick(r,1);assert.equal(r.teams[0].pumpBattery.chargeWh,20);
});
test('large and partitioned pump steps conserve energy and water',()=>{
 const s=fresh(1.0125);onScene(s);startPump(s);const q=JSON.parse(JSON.stringify(s));model.tick(s,45);for(let n=0;n<90;n++)model.tick(q,0.5);near(s.teams[0].pumpBattery.chargeWh,q.teams[0].pumpBattery.chargeWh);near(s.incidents.I1.waterL,q.incidents.I1.waterL);assert.equal(s.teams[0].pumpRunning,q.teams[0].pumpRunning);
});
test('status exposes charge fraction and finite runtime',()=>{
 const p=model.status(fresh(6,10)).teams[0].pump;near(p.battery.percent,0.6);near(p.estimatedRunS,180);assert.equal(p.battery.low,false);assert.equal(p.recharge,null);
});
for(const r of rows)console.log(`${r.passed?'PASS':'FAIL'} ${r.name}${r.error?': '+r.error:''}`);
fs.writeFileSync(new URL('../reports/rescue-battery-integration.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),rows},null,2));
if(rows.some(r=>!r.passed))process.exitCode=1;
