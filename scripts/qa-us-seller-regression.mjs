import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=new URL('../.qa/us-seller-profile/',import.meta.url);mkdirSync(directory,{recursive:true});
const old=JSON.parse(readFileSync(new URL('../docs/evidence/legacy-transport-boundaries-20261008.json',import.meta.url),'utf8'));
const files=[...new Set([...old.finalTests.fileResults.map(result=>result.path),
 'lib/international/saas-authority.test.ts','lib/international/saas-authority.workerd.test.ts','lib/international/saas-authorities.migrations.test.ts',
 'lib/account-workspaces.test.ts','lib/account-workspaces-route.test.ts','lib/account-workspace-pages.test.ts','lib/account-workspace-navigation.test.ts','lib/account-workspace-entry.test.ts',
 'lib/international/seller-profile-server.test.ts','lib/international/seller-profile.test.ts','lib/international/seller-profile.postgres.test.ts','lib/international/runtime-response-guards.test.ts','lib/international/browser-actor-binding.test.ts','lib/international/browser-erp-session.test.ts','lib/international/browser-workbench.test.ts','lib/international/browser-workbench.browser.test.ts',
])].sort((a,b)=>a<b?-1:a>b?1:0);
writeFileSync(new URL('selection.json',directory),JSON.stringify({baseline:'50d125b4dc7650153c9e7caa4ef112840efefdc6',scope:'Selected CH account/billing/transport compatibility plus US authority/workspace/runtime/browser and seller profile tests; not entire repository.',files},null,2));
let status=0,output='';
try{output=execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run','--config','vitest.config.ts',...files,'--maxWorkers=1','--reporter=json','--outputFile=.qa/us-seller-profile/regression.json'],{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024,env:process.env});}
catch(error){status=typeof error.status==='number'?error.status:1;output=(error.stdout||'')+(error.stderr||'');}
writeFileSync(new URL('regression.log',directory),output);console.log(JSON.stringify({status,selectedFiles:files.length,artifact:'.qa/us-seller-profile/regression.json'}));if(status)console.log(output.slice(-6000));process.exitCode=status;
