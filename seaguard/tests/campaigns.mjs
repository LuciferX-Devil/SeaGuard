import fs from 'node:fs';
import assert from 'node:assert/strict';
const seeds=process.argv.slice(2).length?process.argv.slice(2).map(Number):[0,42,1337,2107194343,909756485,250324697,1958751306,566238994,1455188577,172027862,3128125,121280024];
const base=(process.env.SEAGUARD_BASE_URL||'http://127.0.0.1:1880');
const rows=[];
const reportName=process.env.SEAGUARD_REPORT_NAME || 'campaigns';
if(!/^[a-zA-Z0-9_-]+$/.test(reportName))throw Error('Invalid report name');
const request=async p=>{const r=await fetch(base+p,{signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error(`${p}: HTTP ${r.status}`);return r.json();};
for(const seed of seeds){
  await request(`/seaguard/test/run?seed=${seed}&speed=30`);
  const conflict=await fetch(base+'/seaguard/test/run?seed=7&speed=30');
  assert.equal(conflict.status,409,'Concurrent start must not replace the active campaign');
  const deadline=Date.now()+90000;
  let status;
  do{
    await new Promise(r=>setTimeout(r,400));status=await request('/seaguard/test/status');
    if(Date.now()>deadline)throw Error(`Seed ${seed}: timed out in ${status.state}`);
  }while(status.state!=='DONE'||status.seed!==seed);
  const snapshot=await request('/seaguard/state?keys=test,fw,syncStore');
  status.faultTypes=[...new Set(snapshot.test.schedule.map(f=>f.type))];
  const harbour=snapshot.test.layout.roles.harbour;
  if(harbour){assert.equal(snapshot.syncStore[harbour].maxContig,snapshot.fw[harbour].logSeq,'Every harbour record must be stored');assert.equal(snapshot.fw[harbour].logBuffered,0,'No harbour records left unacknowledged');}
  rows.push(status);
  fs.writeFileSync('seaguard/reports/'+reportName+'.json',JSON.stringify({at:new Date().toISOString(),runs:rows},null,2));
  console.log(`seed ${seed}: ${status.results.pass} pass, ${status.results.fail} fail, ${status.results.skip} not exercised`);
  for(const row of status.results.rows.filter(r=>r.result==='FAIL'))console.log(`  FAIL ${row.title}: ${row.observed}`);
}
const totals=rows.reduce((a,s)=>({pass:a.pass+s.results.pass,fail:a.fail+s.results.fail,skip:a.skip+s.results.skip}),{pass:0,fail:0,skip:0});
const coverage=[...new Set(rows.flatMap(s=>s.faultTypes))].sort();
fs.writeFileSync('seaguard/reports/'+reportName+'.md',`# SeaGuard campaign verification\n\nGenerated ${new Date().toISOString()}. ${rows.length} seeds, ${totals.pass} passed checks, ${totals.fail} failed checks, ${totals.skip} checks not exercised. Simulated services only. Each campaign also independently verifies rejection of concurrent start and exact harbour-log completion.\n\n| Seed | Passed | Failed | Not exercised |\n|---|---:|---:|---:|\n`+rows.map(s=>`| ${s.seed} | ${s.results.pass} | ${s.results.fail} | ${s.results.skip} |`).join('\n')+'\n\nObserved fault types: '+coverage.join(', ')+'.\n');
console.log(JSON.stringify(totals));process.exitCode=totals.fail?1:0;
