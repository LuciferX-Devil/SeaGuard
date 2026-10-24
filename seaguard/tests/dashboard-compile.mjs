import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const compiler=require(require.resolve('@vue/compiler-sfc',{paths:['./userdir']}));
const rows=[];
const layout=JSON.parse(fs.readFileSync('seaguard/flow.base.json','utf8'));
for(const name of fs.readdirSync('seaguard/src/dashboard').filter(n=>n.endsWith('.vue'))){
 const filename='seaguard/src/dashboard/'+name;
 const {descriptor,errors}=compiler.parse(fs.readFileSync(filename,'utf8'),{filename});
 const styleOnly=layout.find(n=>n.id===name.slice(0,-4))?.templateScope==='site:style';
 const issues=styleOnly ? [] : [...errors];
 if(styleOnly){if(!descriptor.styles.length)issues.push('Missing site stylesheet');for(const style of descriptor.styles){issues.push(...compiler.compileStyle({source:style.content,filename,id:name}).errors);}}
 if(descriptor.template){const result=compiler.compileTemplate({source:descriptor.template.content,filename,id:name});issues.push(...result.errors);}
 if(descriptor.script){try{compiler.compileScript(descriptor,{id:name});}catch(e){issues.push(e.message);}}
 rows.push({name,passed:!issues.length,errors:issues.map(String)});
}
fs.writeFileSync('seaguard/reports/dashboard-compile.json',JSON.stringify({at:new Date().toISOString(),note:'Offline SFC syntax compilation; does not establish visual correctness.',tests:rows},null,2));
rows.forEach(r=>console.log(`${r.passed?'PASS':'FAIL'} ${r.name} ${r.errors.join('; ')}`));
process.exitCode=rows.some(r=>!r.passed)?1:0;
