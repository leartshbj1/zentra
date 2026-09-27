import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('./language',()=>({useAppLanguage:()=> 'fr'}));
import { AutomationJournal } from './AutomationJournal';
import { AutomationBrief } from './AutomationBrief';
import { activityDayLabel, activityInvoiceAmount, activityTimestamp, invoiceActivityStatus } from './automationPresentation';
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
 const html=renderToStaticMarkup(<AutomationJournal activity={activity} runs={[]} renderRun={()=>null}/>);
 expect(html).toContain('automation-journal__invoice');expect(html).not.toContain('Ouvrir la facture');expect(html).not.toContain('Ouvrir les factures reçues');
});
it('activity-first summary does not present outstanding reviews as completed work',()=>{
 const html=renderToStaticMarkup(<AutomationBrief activity={activity} activityFirst hideAttention onOpen={()=>{}}/>);
 expect(html).toContain('Factures enregistrées dans Gestion');expect(html).not.toContain('Factures à vérifier');expect(html).not.toContain('Voir l’activité');
 const followup=renderToStaticMarkup(<AutomationBrief activity={activity} attentionOnly onOpen={()=>{}}/>);
 expect(followup).toContain('Factures à vérifier');expect(followup).not.toContain('Bonjour');expect(followup).not.toContain('Factures enregistrées dans Gestion');
});
it.each([undefined,null,0,-1,NaN,Infinity,8640000000001])('never manufactures a timestamp from %s',value=>{expect(activityTimestamp(value)).toBe(0);});
it('uses real receipt dates and metadata without presenting extracted amounts as posted entries',()=>{
 const enriched={...activity,timeZone:'Invalid/Zone',supplierInbox:{...activity.supplierInbox!,recent:[{id:'receipt',subject:'Facture reçue',state:'review',automatic:0,imported_at:null,created_at:1790180000,supplierName:'Acme',reference:'AC-42',totalCents:10810,currency:'CHF',sender:'acme@example.test',fileName:'facture.pdf',invoiceId:null}]}};
 const html=renderToStaticMarkup(<AutomationJournal activity={enriched} runs={[]} renderRun={()=>null} openInvoice={()=>{}} openInvoices={()=>{}}/>);
 expect(html).toContain('Acme · AC-42');expect(html).toContain('Montant lu sur la facture');expect(html).toContain('108.10');expect(html).toContain('acme@example.test');expect(html).toContain('À vérifier');
 expect(html).not.toContain('Comptabilisée automatiquement');expect(html).not.toContain('Date non disponible');expect(html).not.toContain('Ouvrir la facture');
});
it('offers the imported invoice destination only with an imported document id',()=>{
 const enriched={...activity,supplierInbox:{...activity.supplierInbox!,recent:[{...activity.supplierInbox!.recent[0],invoiceId:'document-id'}]}};
 const html=renderToStaticMarkup(<AutomationJournal activity={enriched} runs={[]} renderRun={()=>null} openInvoice={()=>{}} openInvoices={()=>{}}/>);
 expect(html).toContain('Ouvrir la facture');expect(html).not.toContain('Ouvrir les factures reçues');
});
it('never presents unknown activity or a historical day as today or all clear',()=>{
 const absent=renderToStaticMarkup(<AutomationBrief onOpen={()=>{}}/>);
 expect(absent).toContain('L’activité n’est pas disponible');expect(absent).not.toContain('Aucune action en attente');expect(absent).not.toContain('Aujourd’hui');
 const old=renderToStaticMarkup(<AutomationBrief activity={activity} onOpen={()=>{}}/>);
 expect(old).toContain('23 septembre 2026');expect(old).not.toContain('Aujourd’hui');
 expect(activityDayLabel('2026-09-27','Europe/Zurich','fr',new Date('2026-09-26T22:05:00Z'))).toBe('Aujourd’hui');
 expect(activityDayLabel('2026-02-31',undefined,'fr')).toBe('Activité disponible');
});
it('formats only valid extracted amounts and never treats review as posted',()=>{
 expect(activityInvoiceAmount(0,'CHF','fr')).toContain('0.00');
 for(const cents of [undefined,null,NaN,-5,1.2,Number.MAX_SAFE_INTEGER+1])expect(activityInvoiceAmount(cents,'CHF','de')).toBeNull();
 expect(activityInvoiceAmount(100,'unknown','fr')).toBeNull();
 expect(invoiceActivityStatus('review',1)).toBe('review');expect(invoiceActivityStatus('ready',1)).toBe('waiting');expect(invoiceActivityStatus('imported',0)).toBe('imported');
});
