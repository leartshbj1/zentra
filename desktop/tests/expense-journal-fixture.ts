import { desktopApi } from '../src/bridge';
import type { JournalEntry, VatProfile, VatReturnPreview, Workspace } from '../src/types';

export function installExpenseJournalFixture(workspace:Workspace) {
  if(!workspace.settings)throw new Error('Fixture requires onboarding settings.');
  workspace.settings.organization.vatRegistered=true;
  const profile:VatProfile={id:'expense-vat',effectiveFrom:'2026-01-01',effectiveTo:null,reportingMethod:'effective',formOfReporting:'agreed',periodicity:'quarterly',grossOrNet:'net',tdfnActivityId:null,tdfnRateBp:null,afcAuthorizationConfirmed:true,notes:'',createdAt:'',updatedAt:''};
  const basePreview:VatReturnPreview={
    standard:'eCH-0217',standardVersion:'2.0.0',currency:'CHF',profile,dateFrom:'2026-04-01',dateTo:'2026-06-30',submissionType:'initial',exportable:false,
    blockingIssues:[],warnings:[],unclassifiedSources:[],classifiedSources:[],receivedAllocations:[],preClosingSources:[],sourceSha256:'synthetic-expense-journal',
    turnoverComputation:{totalConsiderationCents:0,suppliesToForeignCountriesCents:0,suppliesAbroadCents:0,transferNotificationProcedureCents:0,suppliesExemptFromTaxCents:0,reductionOfConsiderationCents:0,variousDeduction:null,taxableTurnoverCents:0},
    effectiveReportingMethod:{grossOrNet:'net',grossOrNetCode:1,optedCents:0,suppliesPerTaxRate:[],acquisitionTax:[],inputTaxMaterialAndServicesCents:0,inputTaxInvestmentsCents:0,subsequentInputTaxDeductionCents:0,inputTaxCorrectionsCents:0,inputTaxReductionsCents:0,outputTaxCents:0,acquisitionTaxCents:0},
    simpleTaxRateMethod:null,payableTaxCents:0,payableCode:'500',otherFlowsOfFunds:{subsidiesCents:0,donationsCents:0},sourceCount:0,adjustmentCount:0,transmissionWording:'Jeu de recette local.'
  };
  desktopApi.listVatProfiles=async()=>[profile];desktopApi.listVatAdjustments=async()=>[];desktopApi.listVatReturnExports=async()=>[];
  const readSettings=desktopApi.getAccountingSettings;
  desktopApi.getAccountingSettings=async()=>({...await readSettings(),enabled:true});
  const readContinuity=desktopApi.getAccountingContinuity;
  desktopApi.getAccountingContinuity=async()=>({...await readContinuity(),enabled:true,mappingReady:true,journalEntryCount:4,totalAnomalies:0});
  const common={entryDate:'2026-02-10',sourceType:'expense',sourceId:'expense-qa',sourceEvent:'create',status:'posted' as const,reversalOf:null,hasReversal:false};
  const entries:JournalEntry[]=[
    {...common,id:'root-qa',number:'J-2026-001',description:'Marchandises · dépense déjà payée',hasReversal:true,reversalAction:'blocked_expense'},
    {...common,id:'active-qa',number:'J-2026-002',description:'Autre dépense payée et conservée',reversalAction:'blocked_expense'},
    {...common,id:'tip-qa',number:'J-2026-ANCIENNE-EXTOURNE-REFERENCE-LONGUE-003',entryDate:'2026-04-10',sourceType:'journal_reversal',sourceEvent:'reverse',reversalOf:'root-qa',description:'Ancienne annulation isolée de la dépense · matériel pour le projet de rénovation',reversalAction:'restore_expense'},
    {...common,id:'manual-qa',number:'J-2026-004',description:'Écriture manuelle à contrôler',sourceType:'manual'},
  ];
  let recorded: {date:string;description:string}|null=null;
  desktopApi.getJournal=async()=>{
    if(sessionStorage.getItem('qa-expense-read-failure')==='1'){sessionStorage.removeItem('qa-expense-read-failure');throw new Error('Lecture interrompue après enregistrement.');}
    return {entries:structuredClone(entries),lines:entries.flatMap(e=>[0,1].map(i=>({id:`${e.id}-${i}`,journalEntryId:e.id,entryNumber:e.number,entryDate:e.entryDate,accountId:i?'bank':'expense',accountCode:i?'1020':'4000',accountName:i?'Banque':'Marchandises et prestations',debitCents:i?0:10810,creditCents:i?10810:0,currency:'CHF',memo:e.description,projectId:null,clientId:null,employeeId:null}))),currency:{baseCurrency:'CHF',currencies:['CHF'],singleCurrency:true,exchangeRatesApplied:false}};
  };
  desktopApi.reverseJournalEntry=async(id,date,description='')=>{
    sessionStorage.setItem('qa-expense-attempts',String(Number(sessionStorage.getItem('qa-expense-attempts')||0)+1));
    if(sessionStorage.getItem('qa-expense-refuse')==='1'){sessionStorage.removeItem('qa-expense-refuse');throw new Error('La période sélectionnée est clôturée. Vos champs restent conservés.');}
    if(id!=='tip-qa')throw new Error('Cette dépense doit rester liée à son paiement.');
    if(recorded && (date!==recorded.date || description!==recorded.description))throw new Error('La correction enregistrée utilise une autre date ou un autre motif.');
    if(!recorded){
      recorded={date,description};entries[2].hasReversal=true;
      entries.push({...common,id:'restored-qa',number:'J-2026-005',entryDate:date,description,sourceType:'journal_reversal',sourceEvent:'reverse',reversalOf:id,reversalAction:'blocked_expense'});
      sessionStorage.setItem('qa-expense-commits','1');
      throw new Error('Réponse perdue après enregistrement. Réessayez avec la même date et le même motif.');
    }
    sessionStorage.setItem('qa-expense-read-failure','1');
  };
  desktopApi.previewVatReturn=async(input)=>{
    const preview={...structuredClone(basePreview),...input};
    preview.exportable=Boolean(recorded);
    preview.blockingIssues=recorded?[]:[{code:'expense_journal_inactive',sourceType:'journal_entry',sourceId:'tip-qa',message:'La dépense MAT-2026-REFERENCE-LONGUE-ACHAT-DU-PROJET reste payée, mais son écriture est annulée au 30.06.2026. Contrôlez l’ancienne extourne et rétablissez la dépense si elle a été annulée par erreur. Aucun ajustement TVA ne peut être déduit de cette extourne isolée.'}];
    return preview;
  };
}
