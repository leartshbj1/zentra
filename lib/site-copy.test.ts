import { describe,it,expect } from 'vitest';
import de from './site-copy/de.json';
import itCopy from './site-copy/it.json';
import en from './site-copy/en.json';
import required from './site-copy/required.json';
import identities from './site-copy/identities.json';
import { translateSiteCopy } from './site-copy-core';

const slots=(text:string)=>[...text.matchAll(/\{\{\d+\}\}/g)].map(m=>m[0]).sort();
const numbers=(text:string)=>[...text.replace(/\{\{\d+\}\}/g,'').matchAll(/\d+(?:[.,]\d+)*/g)].map(m=>m[0]).sort();
describe('complete reviewed website catalogues',()=>{
 for(const [language,dictionary] of Object.entries({de,it:itCopy,en}))it(language+' covers all required copy and preserves variables/numbers',()=>{
  const catalogue=dictionary as Record<string,string>;
  const allowed=new Set(identities[language as keyof typeof identities]);
  for(const source of required){
   const translated=catalogue[source];
   expect(typeof translated,source).toBe('string');expect(translated.trim().length,source).toBeGreaterThan(0);
   expect(slots(translated),source).toEqual(slots(source));
   // URL subjects are human-readable URI-encoded text; their digit sequences are escapes.
   if(!source.startsWith('mailto:'))expect(numbers(translated),source).toEqual(numbers(source));
   if(translated===source)expect(allowed.has(source),source).toBe(true);
  }
 });
 it('keeps official names and complete clauses available to the runtime',()=>{
  for(const dictionary of [de,itCopy,en]){
   expect(translateSiteCopy('Zentra','en',dictionary)).toBe('Zentra');
   expect(translateSiteCopy('Mon compte','en',dictionary)).not.toBe('Mon compte');
  }
  expect(de.Nom).toBe('Nachname');expect(en.Nom).toBe('Last name');expect(itCopy.Nom).toBe('Cognome');
 });
 it('translates navigation labels declared in route tuples', () => {
  for (const dictionary of [de, itCopy, en]) for (const label of ['Tarifs', 'Visite de l’app', 'Connexions', 'Configurer', 'Fonctions', 'Inclus', 'Cas d’usage']) {
    expect(translateSiteCopy(label, 'en', dictionary), label).not.toBe(label);
  }
 });
});
