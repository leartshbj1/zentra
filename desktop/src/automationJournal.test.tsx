import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('./language',()=>({useAppLanguage:()=> 'fr'}));
import { AutomationJournal } from './AutomationJournal';
import { AutomationBrief } from './AutomationBrief';
import { activityTimestamp } from './automationPresentation';
import type { AutomationActivity } from './automation';
const activity: AutomationActivity = {date:'2026-09-23',timeZone:'Europe/Zurich',updatedAt:1790180000,displayName:'Camille',totals:{analyzed:2,suggestions:1,confirmed:1,needsReview:0,observed:0},features:[],supplierInbox:{received:2,imported:1,automatic:1,needsReview:1,recent:[{id:'a',subject:'Facture récente',state:'imported',automatic:1,imported_at:1790180000},{id:'b',subject:'Date inconnue',state:'needs_review',automatic:0,imported_at:0}]}};
it('mixes only supplied events, newest first, and keeps unknown dates honest',()=>{
 const html=renderToStaticMarkup(<AutomationJournal activity={activity} runs={[{id:'old',title:'Ancienne action',state:'completed',createdAt:1790170000,updatedAt:1790170000}]} renderRun={run=><span>{run.title}</span>} openInvoices={()=>{}}/>);
 expect(html.indexOf('Facture récente')).toBeLessThan(html.indexOf('Ancienne action'));
 expect(html.indexOf('Ancienne action')).toBeLessThan(html.indexOf('Date inconnue'));
 expect(html).toContain('Date non disponible');expect(html).not.toContain('1970');
 expect(html).toContain('Comptabilisée automatiquement');expect(html).toContain('À vérifier');
});
it('keeps invoice affordances unavailable without a real destination',()=>{
 expect(renderToStaticMarkup(<AutomationJournal activity={activity} runs={[]} renderRun={()=>null}/>)).toContain('class="automation-journal__invoice" disabled');
});
it('activity-first summary does not present outstanding reviews as completed work',()=>{
 const html=renderToStaticMarkup(<AutomationBrief activity={activity} activityFirst hideAttention onOpen={()=>{}}/>);
 expect(html).toContain('Factures enregistrées dans Gestion');expect(html).not.toContain('Factures à vérifier');expect(html).not.toContain('Voir l’activité');
 const followup=renderToStaticMarkup(<AutomationBrief activity={activity} attentionOnly onOpen={()=>{}}/>);
 expect(followup).toContain('Factures à vérifier');expect(followup).not.toContain('Bonjour');expect(followup).not.toContain('Factures enregistrées dans Gestion');
});
it.each([undefined,null,0,-1,NaN,Infinity])('never manufactures a timestamp from %s',value=>{expect(activityTimestamp(value)).toBe(0);});
