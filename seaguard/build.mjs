import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const nodes=JSON.parse(fs.readFileSync(path.join(root,'flow.base.json'),'utf8'));

// Fleet persistence: wrap the allowlisted fleet function bodies with the runtime
// adapter's before/after hooks. The wrapper resolves the adapter at RUNTIME via
// global.get('fleetRuntime'), so build.mjs never imports persistence/runtime (the
// build-validation fixtures copy build/base/source and must fail on a missing UI
// reference, not a missing module). No hook fires when the runtime global is absent.
// Explicit ID list: every store ALLOWLIST.nodes context node PLUS the save-trigger
// and control nodes (fn002e sync, fn0031 ledger, fn003a run-control, fn003e reset,
// fn004e publisher). fn0002 (bootstrap) is NOT wrapped - it calls initialize itself.
const FLEET_HOOK_IDS=new Set(['fn0006','fn0007','fn000a','fn0010','fn0011','fn0018','fn001b','fn001c','fn001d','fn0020','fn0028','fn0029','fn002e','fn0031','fn003a','fn003e','fn004e','fn004f','fn005d']);
function wrapFleetBody(id,src){
  return "const __rt=global.get('fleetRuntime');\n"
    +"if(__rt&&typeof __rt.before==='function'&&__rt.before('"+id+"',context,global,msg)===false)return null;\n"
    +"try{\n"+src+"\n}finally{\n"
    +"if(__rt&&typeof __rt.after==='function')__rt.after('"+id+"',context,global,msg);\n}\n";
}

const ids=new Set();
for(const n of nodes){
  if(ids.has(n.id))throw Error('Duplicate node '+n.id); ids.add(n.id);
  if(n.type==='function'){
    let src=fs.readFileSync(path.join(root,'src/functions',n.id+'.js'),'utf8');
    if(n.id==='fn003d'){
      // Inline the standalone results module so the oracle can call compute() without
      // a runtime require (Node-RED function scope has no module resolution).
      const res=fs.readFileSync(path.join(root,'src/fleet/results.cjs'),'utf8');
      const anchor="const T = global.get('test');";
      if(!src.includes(anchor))throw Error('fn003d: results injection anchor missing');
      src=src.replace(anchor,anchor+'\n'+res);
    }
    if(FLEET_HOOK_IDS.has(n.id))src=wrapFleetBody(n.id,src);
    n.func=src;
    new Function('msg','node','context','global','flow','env',n.func);
  }
  if(n.type==='ui-template') n.format=fs.readFileSync(path.join(root,'src/dashboard',n.id+'.vue'),'utf8');
}
for(const n of nodes){
  for(const id of (n.wires??[]).flat())if(!ids.has(id))throw Error(`Dangling wire ${n.id} -> ${id}`);
  if(n.z&&!ids.has(n.z))throw Error('Missing parent for '+n.id);
  // Validate config references so missing ui/group/page/theme fail the build.
  if(n.type==='ui-page'){
    if(n.ui&&!ids.has(n.ui))throw Error(`ui-page ${n.id}: missing ui base '${n.ui}'`);
    if(n.theme&&!ids.has(n.theme))throw Error(`ui-page ${n.id}: missing theme '${n.theme}'`);
  }
  if(n.type==='ui-group'){
    if(n.page&&!ids.has(n.page))throw Error(`ui-group ${n.id}: missing page '${n.page}'`);
    if(n.tab&&!ids.has(n.tab))throw Error(`ui-group ${n.id}: missing tab '${n.tab}'`);
  }
  if(n.group&&!ids.has(n.group))throw Error(`${n.type} ${n.id}: missing group '${n.group}'`);
}
fs.writeFileSync(path.join(root,'flows.json'),JSON.stringify(nodes,null,2)+'\n');
console.log(`Built SeaGuard: ${nodes.length} nodes; ${nodes.filter(n=>n.type==='function').length} function blocks parsed; no dangling wires or parent IDs.`);
