import { desktopApi } from '../src/bridge';
import type { CustomerCreditAccountingIssue } from '../src/types';

export function installCustomerCreditContinuityFixture() {
  const base=desktopApi.getAccountingContinuity;
  const settings=desktopApi.getAccountingSettings;
  desktopApi.getAccountingSettings=async()=>({...await settings(),enabled:true});
  const issues:CustomerCreditAccountingIssue[]=Array.from({length:10},(_,i)=>({kind:i<3?'missing_posting':i<9?'invalid_posting':'orphan_journal',settlementId:i===9?null:`event-${i}`,creditNoteId:i===9?null:`credit-${i}`,creditNoteNumber:i===9?'':`AVO-2026-${String(i+1).padStart(3,'0')}`,journalEntryId:i>=3?`entry-${i}`:null,journalNumber:i===9?'J-2026-999':'',journalAvailable:i===9,date:`2026-03-${String(i+1).padStart(2,'0')}`,reference:'Contrôle du règlement des travaux complémentaires dans le bâtiment principal',closedPeriod:i<2,reason:i<3?'Le règlement ne dispose pas encore d’une preuve de comptabilisation.':i===9?'Cette écriture n’est reliée à aucune preuve de règlement client. Vérifiez son origine avant toute reprise.':'L’écriture du règlement est absente, modifiée ou ne correspond plus à sa preuve conservée.'}));
  desktopApi.getAccountingContinuity=async()=>({...await base(),enabled:true,mappingReady:true,starterAvailable:false,journalEntryCount:1,missingCustomerCreditSettlements:1,customerCreditIssues:issues,totalMissing:1,closedHistoryRequiresOpening:2,semanticPostingMismatches:7,totalAnomalies:10});
  const getJournal=desktopApi.getJournal;
  desktopApi.getJournal=async(filter)=>({...await getJournal(filter),entries:[{id:'entry-9',number:'J-2026-999',entryDate:'2026-03-10',description:'Écriture de règlement à rapprocher de son avoir',sourceType:'customer_credit_settlement',sourceId:'missing-event',sourceEvent:'apply',status:'posted',reversalOf:null,hasReversal:false}],lines:[]});
}
