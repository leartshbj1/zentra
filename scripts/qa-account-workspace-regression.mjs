import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const directory=new URL('../.qa/account-workspace-discovery/',import.meta.url);
mkdirSync(directory,{recursive:true});
const baseline='002854a923b764d7b729802452babfe824a96d00';
const previous=JSON.parse(readFileSync(new URL('../docs/evidence/legacy-transport-boundaries-20261008.json',import.meta.url),'utf8'));
const tests=[...new Set([...previous.finalTests.fileResults.map(result=>result.path),
  'lib/international/saas-authority.test.ts',
  'lib/international/saas-authority.workerd.test.ts',
  'lib/international/saas-authorities.migrations.test.ts',
  'lib/account-workspaces.test.ts',
  'lib/account-workspaces-route.test.ts',
  'lib/account-workspace-pages.test.ts',
  'lib/account-workspace-navigation.test.ts',
  'lib/account-workspace-entry.test.ts',
])].sort((a,b)=>a<b?-1:a>b?1:0);
writeFileSync(new URL('selection.json',directory),JSON.stringify({baseline,files:tests,scope:'Same 71-file selected regression set plus three authority and five workspace discovery/entry/UI test files. Not the entire repository.'},null,2));
let status=0,output='';
try { output=execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run','--config','vitest.config.ts',...tests,'--maxWorkers=2','--reporter=json','--outputFile=.qa/account-workspace-discovery/tests.json'],{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024,env:process.env}); }
catch(error){ status=typeof error.status==='number'?error.status:1;output=(error.stdout||'')+(error.stderr||''); }
writeFileSync(new URL('tests.log',directory),output);
const sha256=value=>createHash('sha256').update(value).digest('hex');
const migrationPaths=execFileSync('git',['ls-tree','-r','--name-only',baseline,'drizzle','supabase/migrations'],{cwd:root,encoding:'utf8'}).trim().split(/\r?\n/).filter(path=>path.endsWith('.sql'));
const unchanged=migrationPaths.map(path=>{
  const before=execFileSync('git',['show',baseline+':'+path],{cwd:root,maxBuffer:16*1024*1024});
  const after=readFileSync(new URL('../'+path,import.meta.url));
  // Windows checkout CRLF is a clean-filter difference, not rewritten history.
  // Compare the canonical Git blob, and retain both byte hashes explicitly.
  const baselineBlob=execFileSync('git',['rev-parse',baseline+':'+path],{cwd:root,encoding:'utf8'}).trim();
  const worktreeBlob=execFileSync('git',['hash-object','--path='+path,path],{cwd:root,encoding:'utf8'}).trim();
  return {path,baselineSha256:sha256(before),worktreeSha256:sha256(after),baselineBlob,worktreeBlob,rawBytesUnchanged:sha256(before)===sha256(after),unchanged:baselineBlob===worktreeBlob};
});
if(unchanged.some(item=>!item.unchanged))status=1;
writeFileSync(new URL('migration-preservation.json',directory),JSON.stringify({baseline,comparison:'Canonical Git clean-filter blobs; raw worktree hashes are retained separately for Windows CRLF.',count:unchanged.length,allUnchanged:unchanged.every(item=>item.unchanged),files:unchanged},null,2));
console.log(JSON.stringify({status,testFiles:tests.length,oldSqlFiles:unchanged.length,oldSqlUnchanged:unchanged.every(item=>item.unchanged),log:'.qa/account-workspace-discovery/tests.log'}));
if(status)console.log(output.slice(-12000));
process.exitCode=status;
