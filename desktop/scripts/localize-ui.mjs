// Explicitly selected screens only. Never rewrite business values, keys, identifiers or stored data.
import ts from 'typescript';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const apply = process.argv.includes('--apply');
const functionName = process.argv.find(arg => arg.startsWith('--function='))?.slice('--function='.length);
const files = process.argv.slice(2).filter(arg => arg !== '--apply' && !arg.startsWith('--function='));
const catalog = new Map();
const attributes = new Set(['label','title','description','placeholder','hint','aria-label','emptyTitle','emptyText','eyebrow','text']);
function jsxText(value) {
  const lines=value.split(/\r\n|\n|\r/); let last=-1;
  lines.forEach((line,i)=>{if(/[^ \t]/.test(line))last=i;});
  return lines.map((line,i)=>{let text=line.replace(/\t/g,' ');if(i!==0)text=text.replace(/^ +/,'');if(i!==lines.length-1)text=text.replace(/ +$/,'');return text+(text && i!==last?' ':'');}).join('');
}
function meaningful(value) { return /[a-zA-ZÀ-ÿ]/.test(value) && value.trim() !== 'Zentra' && !/^https?:\/\//.test(value.trim()); }
for (const file of files) {
  const source=await readFile(file,'utf8'), ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const changes=[];
  const replace=(node,value,attribute=false)=>{
    if(!meaningful(value))return;
    const key=value.trim();catalog.set(key,[...(catalog.get(key)||[]),file]);
    changes.push({start:node.getStart(ast),end:node.end,text:`${attribute?'{':''}t(${JSON.stringify(value)})${attribute?'}':''}`});
  };
  function textExpression(node) {
    if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))replace(node,node.text);
    else if(ts.isConditionalExpression(node)){textExpression(node.whenTrue);textExpression(node.whenFalse);}
    else if(ts.isParenthesizedExpression(node))textExpression(node.expression);
    else if(ts.isTemplateExpression(node)) {
      const parts=[node.head.text,...node.templateSpans.map(span=>span.literal.text)];
      if(!parts.some(meaningful))return;
      let key=parts[0];node.templateSpans.forEach((span,index)=>{key+=`{v${index}}`+span.literal.text;});
      catalog.set(key.trim(),[...(catalog.get(key.trim())||[]),file]);
      const values=node.templateSpans.map((span,index)=>`v${index}: ${span.expression.getText(ast)}`).join(', ');
      changes.push({start:node.getStart(ast),end:node.end,text:`t(${JSON.stringify(key)}, { ${values} })`});
    }
  }
  function walk(node) {
    if (ts.isFunctionDeclaration(node) && functionName && node.name?.text !== functionName) return;
    if(ts.isJsxText(node)){const value=jsxText(node.text);if(meaningful(value)){catalog.set(value.trim(),[...(catalog.get(value.trim())||[]),file]);changes.push({start:node.pos,end:node.end,text:`{t(${JSON.stringify(value)})}`});}return;}
    if(ts.isJsxAttribute(node)&&attributes.has(node.name.getText(ast))&&node.initializer&&ts.isStringLiteral(node.initializer))replace(node.initializer,node.initializer.text,true);
    if(ts.isJsxExpression(node)&&node.expression&&(ts.isJsxElement(node.parent)||ts.isJsxFragment(node.parent)||(ts.isJsxAttribute(node.parent)&&attributes.has(node.parent.name.getText(ast)))))textExpression(node.expression);
    ts.forEachChild(node,walk);
  }
  walk(ast);
  if(apply&&changes.length){let output=source;for(const change of changes.sort((a,b)=>b.start-a.start))output=output.slice(0,change.start)+change.text+output.slice(change.end);const hasT=ast.statements.some(node=>ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text==='./language'&&node.importClause?.namedBindings&&ts.isNamedImports(node.importClause.namedBindings)&&node.importClause.namedBindings.elements.some(binding=>binding.name.text==='t'));if(!hasT)output=`import { t } from './language';\n`+output;await writeFile(file,output);}
}
await mkdir('.qa',{recursive:true});
await writeFile('.qa/localization-extracted.json',JSON.stringify(Object.fromEntries([...catalog].sort(([a],[b])=>a.localeCompare(b))),null,2));
console.log(JSON.stringify({ files:files.length, messages:catalog.size, applied:apply }));
