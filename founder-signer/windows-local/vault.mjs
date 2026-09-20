import {spawnSync} from 'node:child_process';
import {readFile,writeFile,rename,unlink,readdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createPrivateKey,createPublicKey} from 'node:crypto';

// Only data goes through stdin. No key, token or arbitrary expression enters
// the command line, an environment variable, a log, or the browser.
export function dpapi(bytes,protect=false){
  if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>32768)throw Error('Contenu du coffre invalide.');
  const command=`$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${protect?'Protect':'Unprotect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r)); [Array]::Clear($b,0,$b.Length); [Array]::Clear($r,0,$r.Length) } catch { [Console]::Error.Write('Windows vault unavailable'); exit 1 }`;
  const result=spawnSync(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',command],{input:bytes.toString('base64'),encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:65536});
  if(result.error||result.status!==0||!/^[A-Za-z0-9+/=]+$/.test(result.stdout))throw Error('Le coffre ne peut pas être ouvert par cette session Windows.');
  return Buffer.from(result.stdout,'base64');
}
export class Vault {
  constructor(root){this.root=root;}
  async read(name){const bytes=await readFile(path.join(this.root,name));return dpapi(bytes);}
  async write(name,bytes){
    const encrypted=dpapi(bytes,true);const tmp=path.join(this.root,'local-write-'+randomUUID()+'.tmp');
    try{await writeFile(tmp,encrypted,{flag:'wx'});await rename(tmp,path.join(this.root,name));}finally{await unlink(tmp).catch(()=>{});}
  }
  async key(kind){
    const clear=await this.read(kind==='admin'?'founder-admin-key.dpapi':'license-signing-key.dpapi');let der;
    try {
      if(kind==='admin') {if(clear.length!==32)throw Error('Clé personnelle invalide.');der=Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),clear]);}
      else der=Buffer.from(clear.toString('utf8').trim(),'base64url');
      const key=createPrivateKey({key:der,type:'pkcs8',format:'der'});
      if(key.asymmetricKeyType!=='ed25519')throw Error('Clé de signature invalide.');return key;
    }finally{clear.fill(0);der?.fill(0);}
  }
  async token(reference){
    if(typeof reference!=='string'||reference.length>160||reference.includes('..')||!/^(owner-license-token|signed-)[a-zA-Z0-9.-]*\.dpapi$/.test(reference))throw Error('Référence de jeton invalide.');
    const clear=await this.read(reference);try{return clear.toString('utf8').trim();}finally{clear.fill(0);}
  }
  async tokens(){return (await readdir(this.root)).filter(n=>/^(owner-license-token|signed-)[a-zA-Z0-9.-]*\.dpapi$/.test(n));}
}
export const rawPublic=key=>createPublicKey(key).export({format:'jwk'}).x;
