import fs from 'node:fs';
import assert from 'node:assert/strict';
const base=(process.env.SEAGUARD_BASE_URL||(process.env.SEAGUARD_BASE_URL||'http://127.0.0.1:1880'))+'/seaguard/rescue';
const state=async()=>{const r=await fetch(base+'/state');assert.equal(r.status,200);return r.json();};
async function command(action,args={}){const r=await fetch(base+'/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...args})});const b=await r.json();assert.equal(r.status,200,b.error);assert.equal(b.ok,true,b.error);return b.view;}
async function until(pred){const deadline=Date.now()+60000;for(;;){const s=await state();if(pred(s))return s;if(Date.now()>deadline)throw Error('Live scenario timed out at '+JSON.stringify({scenario:s.scenario,t:s.simTime,incident:s.incident,teams:s.teams}));await new Promise(r=>setTimeout(r,250));}}
const rows=[];
for(const scenario of ['FLOODING','MAN_OVERBOARD','RADIO_FAILURE','BOUNDARY_APPROACH']){
 await command('reset');await command('start',{scenario});await command('setSpeed',{speed:20});
 await command('dispatch',{teamId:'T2',personnel:6,recoveryKit:true});
 const conflict=await fetch(base+'/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'dispatch',teamId:'T2',personnel:1,recoveryKit:false})});assert.equal(conflict.status,400,'busy team must reject double booking');
 await until(s=>s.teams.find(t=>t.id==='T2').status==='ON_SCENE');
 await command('command',{teamId:'T2',action2:'ACKNOWLEDGE'});
 if(scenario==='FLOODING'){await command('command',{teamId:'T2',action2:'START_PUMP'});await command('repair');}
 if(scenario==='RADIO_FAILURE')await command('radioRepair');
 if(scenario==='BOUNDARY_APPROACH')await command('returnSafe');
 const safe=await until(s=>s.incident.status==='RESOLVED' && s.results?.vesselSafe && s.results?.crewSafe);
 assert.equal(safe.allClear,false,'team still on scene');
 await command('command',{teamId:'T2',action2:'RETURN'});
 const end=await until(s=>s.allClear);
 assert.equal(end.teams.find(t=>t.id==='T2').status,'IDLE');assert.equal(end.shared.recoveryKits.available,1);assert.equal(end.missions[0].status,'COMPLETED');assert.equal(end.save.ok,true);
 await command('pause');await command('save');const restored=await command('load');assert.equal(restored.paused,true);assert.equal(restored.simTime,end.simTime);
 rows.push({scenario,passed:true,simTime:end.simTime,results:end.results});console.log('PASS live '+scenario);
 fs.writeFileSync('seaguard/reports/rescue-live-scenarios.json',JSON.stringify({at:new Date().toISOString(),runs:rows},null,2));
}
