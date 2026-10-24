import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const nodes=JSON.parse(fs.readFileSync(path.join(root,'flow.base.json'),'utf8'));
const ids=new Set();
for(const n of nodes){
  if(ids.has(n.id))throw Error('Duplicate node '+n.id); ids.add(n.id);
  if(n.type==='function'){
    n.func=fs.readFileSync(path.join(root,'src/functions',n.id+'.js'),'utf8');
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
