import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
process.chdir(path.dirname(fileURLToPath(import.meta.url)));
let failed=0;for(const n of ["rescue-battery","rescue-battery-controller","rescue-battery-integration","rescue-battery-state","rescue-model","rescue-exercise","rescue-persistence","rescue-review","regressions","outbox-regressions","dashboard-compile"]){console.log('\n'+n);const r=spawnSync(process.execPath,['seaguard/tests/'+n+'.mjs'],{stdio:'inherit'});if(r.status!==0)failed++;}process.exitCode=failed?1:0;
