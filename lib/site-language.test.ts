import { describe, it, expect, vi } from 'vitest';
import { resolveSiteLanguage, localizedSiteUrl } from './site-language';
import { translateSiteCopy, translateSiteUi, translateSiteMetadata, translateSiteStructuredData } from './site-copy-core';
import { transformSiteUi, cleanJsxText } from '../scripts/site-i18n-plugin.mjs';
import ts from 'typescript';
import { translateSiteCount } from './site-count-copy';
import { siteText as clientSiteText, currentSiteLanguage as clientLanguage } from './site-language-client';
import { localizedSiteMailto, siteInvitationMail, siteServiceCopy } from './site-service-copy';
import { siteNumberFormatter } from './site-number-format';

const dictionary = {'Mon compte':'Mein Konto','Bonjour {{0}}.':'Hallo {{0}}.','Logiciel suisse':'Schweizer Software','Erreur de connexion':'Anmeldefehler'};
describe('site language belongs to one request',()=>{
 it.each(['fr','de','it','en'])('explicit %s overrides cookie/browser',language=>{
  expect(resolveSiteLanguage(new Request('https://zentraapp.ch/compte?lang='+language,{headers:{cookie:'zentra_locale=de','accept-language':'it-CH'}}))).toBe(language);
 });
 it('uses saved choice ahead of browser',()=>expect(resolveSiteLanguage(new Request('https://zentraapp.ch/',{headers:{cookie:'other=1; zentra_locale=it; other2=2','accept-language':'de-CH'}}))).toBe('it'));
 it('ignores unsupported and malformed inputs',()=>expect(resolveSiteLanguage(new Request('https://zentraapp.ch/?lang=%3Cscript%3E',{headers:{cookie:'zentra_locale=other','accept-language':'es;q=1,en;q=.8,de;q=0'}}))).toBe('en'));
 it('respects browser preference weights',()=>expect(resolveSiteLanguage(new Request('https://zentraapp.ch/',{headers:{'accept-language':'de-CH;q=0.2,it-CH;q=0.9,en;q=0.8'}}))).toBe('it'));
 it('defaults safely without a supported preference',()=>expect(resolveSiteLanguage(new Request('https://zentraapp.ch/',{headers:{'accept-language':'es,*;q=0'}}))).toBe('fr'));
 it('has no mutable language shared between requests',async()=>{
  const results=await Promise.all(Array.from({length:100},async(_,i)=>{await new Promise(r=>setTimeout(r,i%3));return resolveSiteLanguage(new Request('https://zentraapp.ch/?lang='+['fr','de','it','en'][i%4]));}));
  expect(results).toEqual(Array.from({length:100},(_,i)=>['fr','de','it','en'][i%4]));
 });
 it('preserves navigation query and fragment',()=>expect(localizedSiteUrl('https://zentraapp.ch/connexion?retour=%2Fsupport%2Fespace&lang=fr#formulaire','de')).toBe('/connexion?retour=%2Fsupport%2Fespace&lang=de#formulaire'));
});
describe('only curated interface messages change',()=>{
 it('uses deterministic Swiss grouping in server and browser number rendering',()=>{
  expect(siteNumberFormatter('de').format(15000)).toBe('15’000');expect(siteNumberFormatter('it').format(2000)).toBe('2’000');expect(siteNumberFormatter('en').format(2000)).toBe('2,000');expect(siteNumberFormatter('fr',{maximumFractionDigits:1}).format(2000.5)).toBe('2’000,5');
 });
 it('preserves whitespace inside interpolated names and values',()=>expect(translateSiteCopy('Bonjour Fournisseur  du\nLac\u00a0SA.','de',dictionary)).toBe('Hallo Fournisseur  du\nLac\u00a0SA.'));
 it('refreshes a client dictionary after a different locale arrives through RSC',()=>{
  const element={dataset:{siteLanguage:'de'},textContent:JSON.stringify({'Mon compte':'Mein Konto'})};
  vi.stubGlobal('document',{documentElement:{lang:'de-CH'},getElementById:()=>element});
  try {expect(clientSiteText('Mon compte')).toBe('Mein Konto');element.dataset.siteLanguage='it';element.textContent=JSON.stringify({'Mon compte':'Il mio account'});expect(clientLanguage()).toBe('it');expect(clientSiteText('Mon compte')).toBe('Il mio account');}finally{vi.unstubAllGlobals();}
 });
 it('uses language-specific plural forms rather than French suffixes',()=>{
  expect(translateSiteCount('people',3,'en')).toBe('3 people');expect(translateSiteCount('people',1,'de')).toBe('1 Person');expect(translateSiteCount('people',0,'it')).toBe('0 persone');
  expect(translateSiteCopy('Il reste 3 personnes.','it',{'Il reste {{0}} personne{{1}}.':'Restano {{0}} persona{{1}}.'})).toBe('Restano 3 persone.');
 });
 it('preserves French text verbatim',()=>expect(translateSiteCopy(' Mon compte ','fr',dictionary)).toBe(' Mon compte '));
 it('retains meaningful edge spaces',()=>expect(translateSiteCopy(' Mon\ncompte ','de',dictionary)).toBe(' Mein Konto '));
 it('preserves customer names and arbitrary received content',()=>{
  for(const value of ['Atelier du Léman','Ma facture personnelle de novembre','test@zentraapp.ch','INV-2026-123','<script>alert(1)</script>'])expect(translateSiteCopy(value,'de',dictionary)).toBe(value);
 });
 it('keeps interpolated values intact',()=>expect(translateSiteCopy('Bonjour Fournisseur <&>.','de',dictionary)).toBe('Hallo Fournisseur <&>.'));
 it('does not traverse customer objects or React elements',()=>{
  const data={name:'Mon compte',body:'Erreur de connexion'};expect(translateSiteUi(data,'de',dictionary)).toBe(data);
 });
 it('does not treat inherited properties as copy',()=>expect(translateSiteCopy('toString','de',dictionary)).toBe('toString'));
 it('localizes metadata while preserving URLs, numbers and ownership',()=>{
  const input={title:'Logiciel suisse',openGraph:{locale:'fr_CH',url:'https://zentraapp.ch/gestion',images:[{url:'/og.png',alt:'Logiciel suisse',width:1200}]} };
  expect(translateSiteMetadata(input,'de',dictionary)).toEqual({title:'Schweizer Software',openGraph:{locale:'de_CH',url:'https://zentraapp.ch/gestion',images:[{url:'/og/de.png',alt:'Schweizer Software',width:1200}]}});
  expect(input.title).toBe('Logiciel suisse');
 });
 it('keeps JSON-LD identity and numeric prices intact',()=>expect(translateSiteStructuredData({name:'Zentra',description:'Logiciel suisse',inLanguage:'fr-CH',price:49,url:'/gestion'},'de',dictionary)).toEqual({name:'Zentra',description:'Schweizer Software',inLanguage:'de-CH',price:49,url:'/gestion'}));
});
describe('compile-time interface adapter',()=>{
 it('keeps JSX entity semantics when converting text into an expression',()=>expect(cleanJsxText('TVA&nbsp;: &amp; &#39;')).toBe("TVA\u00a0: & '"));
 const source=`'use client';\nconst names=[{id:'facture',label:'Mon compte'}]; export function Example({workspace,ticket}) {return <section id="facture" className="mon-compte"><h1>Mon compte</h1><input name="email" value={workspace.name} placeholder="Mon compte"/><p>{workspace.name}</p><p>{ticket.subject}</p><p>{ticket.body}</p><p>{names[0].label}</p><p>{error}</p><div data-site-raw>{name}</div></section>}`;
 it('preserves client directive, identifiers, CSS, input and customer content',()=>{
  const output=transformSiteUi(source,'components/example.tsx')!.code;
  expect(output.startsWith("'use client';")).toBe(true);expect(output).toContain('id="facture" className="mon-compte"');expect(output).toContain('value={workspace.name}');
  expect(output).toContain('<p>{workspace.name}</p>');expect(output).toContain('<p>{ticket.subject}</p>');expect(output).toContain('<p>{ticket.body}</p>');expect(output).toContain('<div data-site-raw>{name}</div>');
  expect(output).toContain('__siteText(names[0].label)');expect(output).toContain('__siteText(error)');expect(output).toContain('placeholder={__siteText("Mon compte")}');
  const parsed=ts.transpileModule(output,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX},reportDiagnostics:true});expect(parsed.diagnostics).toEqual([]);
 });
 it('excludes APIs and business libraries',()=>{
  expect(transformSiteUi(source,'app/api/account/route.ts')).toBeNull();expect(transformSiteUi(source,'lib/account.ts')).toBeNull();
 });
 it('localizes only curated mail subjects and preserves recipients and invitation links',()=>{
  const uri='mailto:info@zentraapp.ch?subject=Installation%20Windows&body=Texte%20personnel';
  const result=new URL(localizedSiteMailto(uri,'de'));
  expect(result.pathname).toBe('info@zentraapp.ch');expect(result.searchParams.get('subject')).toBe('Windows-Installation');expect(result.searchParams.get('body')).toBe('Texte personnel');
  expect(localizedSiteMailto('mailto:client@example.com?subject=Ma%20facture','en')).toBe('mailto:client@example.com?subject=Ma%20facture');
  for(const language of ['fr','de','it','en'] as const){const invitation=siteInvitationMail(language,'ADMIN_CUSTOM','https://zentraapp.ch/invitation?t=opaque');expect(invitation.body).toContain('ADMIN_CUSTOM');expect(invitation.body).toContain('https://zentraapp.ch/invitation?t=opaque');expect(invitation.body).toContain('\n\n');expect(siteServiceCopy('maintenance',language)).toBeTruthy();}
  const output=transformSiteUi(`export function Page(){return <a href="${uri}">Contact</a>}`,'app/example/page.tsx')!.code;expect(output).toContain('href={__siteMailto(');
 });
 it('reads metadata per request instead of translating at module initialization',()=>{
  const output=transformSiteUi("export const metadata={title:'Logiciel suisse'}; export default function Page(){return <p>Mon compte</p>}",'app/example/page.tsx')!.code;
  expect(output).toContain('const __zentraSourceMetadata');expect(output).toContain('export function generateMetadata()');expect(output).not.toContain('export const metadata');
 });
 it('localizes conditional button text and preserves actions and enum values',()=>{
  const output=transformSiteUi(`export function Page(){return <button onClick={()=>send({mode:'connexion'})}>{busy?'Patientez…':'Mon compte'}</button>}`,'components/example.tsx')!.code;
  expect(output).toContain("onClick={()=>send({mode:'connexion'})}");expect(output).toContain("__siteText(busy?'Patientez…':'Mon compte')");
 });
 it('handles comparisons and customer-dependent literal fallback without changing data',()=>{
  const output=transformSiteUi(`export function Page(){return <section><p>{score<50?'À vérifier':'Terminé'}</p><p>{password.length<8?'Mot de passe trop court':'Prêt'}</p><input placeholder={company.name||'Votre entreprise'}/><p>{user.firstName?\`Bonjour \${user.firstName}\`:'Bonjour'}</p></section>}`,'components/example.tsx')!.code;
  expect(output).toContain("__siteText(score<50?'À vérifier':'Terminé')");expect(output).toContain("password.length<8?__siteText('Mot de passe trop court'):__siteText('Prêt')");expect(output).toContain("company.name||__siteText('Votre entreprise')");expect(output).toContain('user.firstName?__siteText(`Bonjour ${user.firstName}`)');
  expect(ts.transpileModule(output,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX},reportDiagnostics:true}).diagnostics).toEqual([]);
 });
 it('localizes dates nested inside a translated JSX expression',()=>{
  const output=transformSiteUi(`export function Page(){return <p>{new Intl.DateTimeFormat('fr-CH',{dateStyle:'long'}).format(date)}</p>}`,'components/example.tsx')!.code;
  expect(output).toContain("__siteText(new Intl.DateTimeFormat(__siteLocale(),{dateStyle:'long'}).format(date))");expect(output).not.toContain("DateTimeFormat('fr-CH'");
 });
 it('leaves zero-argument calls intact and normalises nested number formatting',()=>{
  const output=transformSiteUi(`const state=useState();export function Page(){return <p>{new Intl.NumberFormat('fr-CH').format(15000)} {count.toLocaleString('fr-CH')}</p>}`,'components/example.tsx')!.code;
  expect(output).toContain('useState()');expect(output).toContain('__siteNumberFormat().format(15000)');expect(output).toContain('__siteLocalizedString(count)');
 });
 it('translates a literal alternative next to a JSX alternative',()=>{
  const output=transformSiteUi(`export function Page(){return <button>{ignored?<><i/>Rétablir</>:'Ignorer'}</button>}`,'components/example.tsx')!.code;
  expect(output).toContain("__siteText('Ignorer')");expect(output).toContain('__siteText("Rétablir")');
 });
});
