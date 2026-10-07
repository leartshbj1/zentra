import ts from 'typescript';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)).replace(/\\/g,'/').replace(/\/$/,'');
const uiAttributes=new Set(['title','subtitle','label','description','hint','help','text','message','tooltip','placeholder','alt','aria-label','aria-description','pendingLabel','successLabel','errorLabel']);
const customerFields=/\b(?:subject|body|sender|senderEmail|organizationName|displayName|file_name|invoice_number|reference|externalId|triageContext|signature|password|email|companyName|businessName)\b|\b(?:user|workspace|company|business|organization|profile|customer|supplier|client|member|agent|team|org|connection|mailbox)\??\.\s*(?:name|firstName|lastName|first_name|last_name|label|title|description|email|address|notes|id)\b|^name$/;
export function cleanJsxText(value){
 value=value.replace(/&nbsp;/g,'\u00a0').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{const code=Number.parseInt(n.startsWith('x')?n.slice(1):n,n.startsWith('x')?16:10);return code<=0x10ffff?String.fromCodePoint(code):_;});
 const lines=value.replace(/\r\n?/g,'\n').split('\n');let last=-1;for(let i=0;i<lines.length;i++)if(/[^\t ]/.test(lines[i]))last=i;
 return lines.map((line,i)=>{line=line.replace(/\t/g,' ');if(i!==0)line=line.replace(/^ +/,'');if(i!==lines.length-1)line=line.replace(/ +$/,'');return line+(line&&i!==last?' ':'');}).join('');
}
export function transformSiteUi(code,relative){
 // Country-specific US content owns its English copy and canonical metadata.
 if(relative.startsWith('app/us/')||relative.startsWith('components/us/'))return null;
 if(!/^(?:app|components)\//.test(relative)||relative.startsWith('app/api/')||!/\.tsx$/.test(relative)||/\.(?:test|spec)\./.test(relative)||relative==='components/site-language-picker.tsx')return null;
 const sf=ts.createSourceFile(relative,code,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),edits=[];let used=false;
 const edit=(start,end,text)=>{edits.push({start,end,text});used=true;};
 function isLocaleArgument(n){return ts.isStringLiteral(n)&&n.text==='fr-CH'&&(ts.isCallExpression(n.parent)||ts.isNewExpression(n.parent))&&/\b(?:toLocaleString|toLocaleDateString|toLocaleTimeString|DateTimeFormat|NumberFormat)\b/.test(n.parent.expression.getText(sf));}
 function formattingReplacement(n){
  if((!ts.isNewExpression(n)&&!ts.isCallExpression(n))||!n.arguments?.length||!ts.isStringLiteral(n.arguments[0])||n.arguments[0].text!=='fr-CH')return null;
  if(ts.isNewExpression(n)&&n.expression.getText(sf)==='Intl.NumberFormat')return '__siteNumberFormat('+n.arguments.slice(1).map(arg=>localizedExpression(arg)).join(',')+')';
  if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='toLocaleString')return '__siteLocalizedString('+localizedExpression(n.expression.expression)+(n.arguments.length>1?','+n.arguments.slice(1).map(arg=>localizedExpression(arg)).join(','):'')+')';
  return null;
 }
 function localizedExpression(expression){let result=expression.getText(sf),localeEdits=[];const start=expression.getStart(sf);function collect(n){const replacement=formattingReplacement(n);if(replacement){localeEdits.push({start:n.getStart(sf)-start,end:n.getEnd()-start,text:replacement});return;}if(isLocaleArgument(n))localeEdits.push({start:n.getStart(sf)-start,end:n.getEnd()-start,text:'__siteLocale()'});ts.forEachChild(n,collect);}collect(expression);for(const change of localeEdits.reverse())result=result.slice(0,change.start)+change.text+result.slice(change.end);return result;}
 function hasJsx(node){if(ts.isJsxElement(node)||ts.isJsxSelfClosingElement(node)||ts.isJsxFragment(node))return true;let found=false;ts.forEachChild(node,child=>{if(hasJsx(child))found=true;});return found;}
 function translateOwnedBranches(expression){
  if(ts.isStringLiteral(expression)||ts.isNoSubstitutionTemplateLiteral(expression)||ts.isTemplateExpression(expression))return translateExpression(expression);
  if(ts.isConditionalExpression(expression)){const yes=translateOwnedBranches(expression.whenTrue),no=translateOwnedBranches(expression.whenFalse);return yes||no;}
  if(ts.isParenthesizedExpression(expression))return translateOwnedBranches(expression.expression);
  if(ts.isBinaryExpression(expression)&&[ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(expression.operatorToken.kind))return translateOwnedBranches(expression.right);
  return false;
 }
 function translateExpression(expression){const original=expression.getText(sf);if(/^(?:__siteText|siteText|__siteMetadata|siteMetadata)\(/.test(original))return false;
  if(hasJsx(expression)){translateOwnedBranches(expression);return false;}
  if(original.startsWith('siteCount('))return false;
  if(customerFields.test(original)&&!ts.isTemplateExpression(expression)&&!ts.isStringLiteral(expression)&&!ts.isNoSubstitutionTemplateLiteral(expression))return translateOwnedBranches(expression);
  edit(expression.getStart(sf),expression.getEnd(),'__siteText('+localizedExpression(expression)+')');return true;}
 function visit(n){
  if((ts.isJsxElement(n)||ts.isJsxSelfClosingElement(n))&&(ts.isJsxElement(n)?n.openingElement:n).attributes.properties.some(p=>ts.isJsxAttribute(p)&&p.name.getText(sf)==='data-site-raw'))return;
  if(ts.isJsxText(n)){const value=cleanJsxText(n.text);if(value.trim())edit(n.getFullStart(),n.getEnd(),'{__siteText('+JSON.stringify(value)+')}');return;}
  if(ts.isJsxExpression(n)&&n.expression){const p=n.parent;let wrapped=false;if(ts.isJsxAttribute(p)){if(uiAttributes.has(p.name.getText(sf)))wrapped=translateExpression(n.expression);}
   else if(ts.isJsxElement(p)||ts.isJsxFragment(p))wrapped=translateExpression(n.expression);
   if(wrapped)return;
  }
  if(ts.isJsxAttribute(n)&&uiAttributes.has(n.name.getText(sf))&&n.initializer&&ts.isStringLiteral(n.initializer)){
   edit(n.initializer.getStart(sf),n.initializer.getEnd(),'{__siteText('+JSON.stringify(n.initializer.text)+')}');return;}
  if(ts.isJsxAttribute(n)&&n.name.getText(sf)==='href'&&n.initializer&&ts.isStringLiteral(n.initializer)&&n.initializer.text.startsWith('mailto:')&&n.initializer.text.includes('subject=')){
   edit(n.initializer.getStart(sf),n.initializer.getEnd(),'{__siteMailto('+JSON.stringify(n.initializer.text)+')}');return;}
  if(ts.isVariableStatement(n)&&n.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)){
   const declaration=n.declarationList.declarations.find(d=>ts.isIdentifier(d.name)&&d.name.text==='metadata');
   if(declaration?.initializer&&n.declarationList.declarations.length===1){
    edit(n.getStart(sf),n.getEnd(),'const __zentraSourceMetadata = () => ('+declaration.initializer.getText(sf)+');\nexport function generateMetadata() { return __siteMetadata(__zentraSourceMetadata()); }');return;
   }
  }
  const formatting=formattingReplacement(n);if(formatting){edit(n.getStart(sf),n.getEnd(),formatting);return;}
  if(isLocaleArgument(n)){edit(n.getStart(sf),n.getEnd(),'__siteLocale()');return;}
  ts.forEachChild(n,visit);
 }
 visit(sf);if(!used)return null;
 edits.sort((a,b)=>a.start-b.start);for(let i=1;i<edits.length;i++)if(edits[i].start<edits[i-1].end)throw new Error('Overlapping site-copy edits: '+relative);
 let output=code;for(const e of [...edits].reverse())output=output.slice(0,e.start)+e.text+output.slice(e.end);
 const directives=sf.statements.filter(ts.isExpressionStatement).filter(s=>ts.isStringLiteral(s.expression));
 const insert=directives[0]?.getEnd()??0;
 output=output.slice(0,insert)+'\nimport { siteText as __siteText, siteLocale as __siteLocale, siteMetadata as __siteMetadata, siteMailto as __siteMailto, siteNumberFormat as __siteNumberFormat, siteLocalizedString as __siteLocalizedString } from "zentra:site-language";\n'+output.slice(insert);
 return {code:output,map:null};
}
export function siteI18nPlugin(){return{
 name:'zentra-site-i18n',enforce:'pre',
 resolveId(id){if(id==='zentra:site-language')return '\0zentra:site-language:'+ (this.environment?.name==='client'?'client':'server');},
 load(id){if(id.startsWith('\0zentra:site-language:'))return 'export {siteText,siteLocale,siteMetadata,siteMailto,siteCount,siteNumberFormat,siteLocalizedString,currentSiteLanguage} from '+JSON.stringify(root+'/lib/site-language-'+id.split(':').at(-1)+'.ts')+';';},
 transform(code,id){const clean=id.split('?')[0].replace(/\\/g,'/');if(!clean.startsWith(root+'/'))return null;
  let source=code;if(this.environment?.name!=='client'&&clean.endsWith('/components/site-language-picker.tsx'))source=source.replace('@/lib/site-language-client','@/lib/site-language-server');
  const result=transformSiteUi(source,clean.slice(root.length+1));return result|| (source!==code?{code:source,map:null}:null);
 },
};}
