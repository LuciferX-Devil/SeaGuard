import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
import exercise from '../src/rescue/exercise.cjs';
import runtime from '../src/fleet/runtime.cjs';
const rows=[];function test(name,fn){try{fn();rows.push({name,passed:true});console.log('PASS '+name);}catch(e){rows.push({name,passed:false,error:e.stack});console.error(e);process.exitCode=1;}}
test('fleet HTTP requests return 503 during bootstrap instead of hanging',()=>{
 const rt=runtime.createRuntime({dataDir:'seaguard/tests/fixtures/readiness-no-store'}),values=new Map([['fleetRuntime',rt]]);
 const scope={get:k=>values.get(k),set:(k,v)=>values.set(k,v)};
 const nodes=JSON.parse(fs.readFileSync('seaguard/flows.json'));
 for(const id of ['fn004f','fn005d']){
  const f=new Function('msg','node','context','global','flow','env',nodes.find(n=>n.id===id).func);
  let result=f({payload:{action:'save'}},{},scope,scope,{},{});if(Array.isArray(result))result=result[1];
  assert.equal(result.statusCode,503);assert.equal(result.payload.ok,false);
 }
});
for(const component of ['ui0058','uiRescue'])test(component+' retains map choice and falls back after tile failure',()=>{
 const source=fs.readFileSync('seaguard/src/dashboard/'+component+'.vue','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
 const storage=new Map([['seaguard.map./worldmap','Esri Ocean']]);const sandbox={module:{exports:{}},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},setTimeout:fn=>fn()};
 vm.runInNewContext(source.replace('export default','module.exports ='),sandbox);
 const events={},active=new Set(),layers={};
 const map={hasLayer:l=>active.has(l),removeLayer:l=>active.delete(l),fire:(e,v)=>events[e]?.(v),on:(e,f)=>events[e]=f};
 for(const n of ['OSM','Esri Ocean'])layers[n]={events:{},addTo(){active.add(this);},on(e,f){this.events[e]=f;}};
 const state={mapNotice:''};const frame={isConnected:true,getAttribute:()=>'/worldmap',contentWindow:{map,basemaps:layers}};
 sandbox.module.exports.methods.mapLoaded.call(state,{target:frame});
 assert(active.has(layers['Esri Ocean']));
 layers['Esri Ocean'].events.tileerror();assert(active.has(layers.OSM));assert.equal(storage.get('seaguard.map./worldmap'),'OSM');assert.match(state.mapNotice,/instead/);
 layers.OSM.events.tileerror();assert.match(state.mapNotice,/internet/);
});
test('default rescue launch and eastbound scenario positions use the revised offshore envelope',()=>{
 const w=exercise.createExercise();assert.equal(w.state.harbour.lon,79.335);assert.equal(w.state.harbour.lat,9.28);
 for(const scenario of ['FLOODING','RADIO_FAILURE','MAN_OVERBOARD','BOUNDARY_APPROACH']){
  const a=exercise.createExercise();exercise.start(a.state,a.ex,{scenario});const p=a.state.incidents[a.ex.incidentId].position;
  assert(p.lon>=79.335&&p.lat>9.27&&p.lat<9.30);
 }
});
test('explicit reset updates only the retired default and keeps state/controller coordinates aligned',()=>{
 const old=exercise.createExercise({harbour:{lat:9.2876,lon:79.3129}});
 exercise.reset(old.state,old.ex);assert.equal(old.state.harbour.lon,79.335);assert.equal(old.ex.harbour.lon,79.335);
 exercise.start(old.state,old.ex,{scenario:'RADIO_FAILURE'});assert(old.state.incidents[old.ex.incidentId].position.lon>79.335);
 const custom=exercise.createExercise({harbour:{lat:10,lon:80}});exercise.reset(custom.state,custom.ex);
 assert.equal(custom.state.harbour.lon,80);assert.equal(custom.ex.harbour.lat,10);
});
test('architecture harness explanation uses two bounded lines',()=>{
 const s=fs.readFileSync('seaguard/src/dashboard/ui0059.vue','utf8');assert(s.includes('<tspan x="240" dy="14">'));assert(!s.includes('then checks the outcome</text>'));
});
fs.writeFileSync('seaguard/reports/visual-corrections.json',JSON.stringify({at:new Date().toISOString(),note:'Source and behavior checks; geographical placement and layout still require user screenshots.',rows},null,2));
