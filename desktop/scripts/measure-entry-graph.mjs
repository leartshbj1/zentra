import fs from 'node:fs';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import ts from 'typescript';

// Static graph only. Dynamic imports, native IPC and later navigation are not a transfer estimate.
const root=path.resolve('dist'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const entries=[...html.matchAll(/(?:src|href)="([^"?]+\.js)"/g)].map(match=>path.resolve(root,match[1]));
const seen=new Set();const files=[];
function read(file){
 if(seen.has(file))return;seen.add(file);
 if(!file.startsWith(root+path.sep))throw Error('Asset outside build');
 const source=fs.readFileSync(file);files.push({file:path.relative(root,file),bytes:source.length,gzipBytes:gzipSync(source).length});
 const ast=ts.createSourceFile(file,source.toString(),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 for(const statement of ast.statements){
  const specifier=(ts.isImportDeclaration(statement)||ts.isExportDeclaration(statement))?statement.moduleSpecifier:null;
  if(specifier&&ts.isStringLiteral(specifier)&&specifier.text.startsWith('.'))read(path.resolve(path.dirname(file),specifier.text));
 }
}
entries.forEach(read);
const result={scope:'HTML entry and static JS dependencies; excludes dynamic modules and native work',files,bytes:files.reduce((n,f)=>n+f.bytes,0),gzipBytes:files.reduce((n,f)=>n+f.gzipBytes,0)};
if(process.argv[2]){fs.mkdirSync(path.dirname(process.argv[2]),{recursive:true});fs.writeFileSync(process.argv[2],JSON.stringify(result,null,2));}
console.log(JSON.stringify({files:files.length,bytes:result.bytes,gzipBytes:result.gzipBytes}));
