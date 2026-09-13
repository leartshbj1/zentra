import { describe, expect, it } from 'vitest';
import { agendaDuration, agendaFormIssue, agendaMerge, agendaNativeIssue, changeAgendaStartDate, eventDraft, requireAgendaWorkspace } from './agendaForm';
import type { AgendaEvent, Workspace } from './types';
import { initialOnboardingSettings } from './onboardingDraft';

const stored: AgendaEvent = { id:'event',title:'Visite',startDate:'2026-09-13',endDate:'2026-09-13',allDay:false,startTime:'09:00',endTime:'10:00',kind:'visit',status:'scheduled',location:'Lausanne',notes:'Apporter les plans',projectId:null,employeeId:null,createdAt:'a',updatedAt:'a' };
const workspace = { onboardingCompleted:true,settings:initialOnboardingSettings,projects:[],employees:[],agendaEvents:[stored] } as unknown as Workspace;
const original = eventDraft(stored);
describe('dates et corrections de l’agenda', () => {
  it.each([
    ['title','   '],['startDate',''],['startDate','2026-02-29'],['endDate','2026-09-12'],['endDate',''],['startTime','9:00'],['startTime','24:00'],['endTime','08:00'],['endTime','09:00'],['endTime','10:60'],['location','a'.repeat(501)],['notes','a'.repeat(20001)],['projectId','missing'],['employeeId','missing'],['kind','invalid'],['status','invalid'],
  ])('renvoie le champ %s à corriger', (field,value) => {
    expect(agendaFormIssue({...original,[field]:value},workspace,original)?.field).toBe(field);
  });
  it('accepte une journée entière sans horaires et une intervention jusqu’au lendemain', () => {
    expect(agendaFormIssue({...original,allDay:true,startTime:null,endTime:null},workspace,original)).toBeUndefined();
    expect(agendaFormIssue({...original,startTime:'23:00',endTime:'02:00',endDate:'2026-09-14'},workspace,original)).toBeUndefined();
  });
  it('suit une seule journée vers le passé ou le futur, sans raccourcir une période personnalisée', () => {
    expect(changeAgendaStartDate(original,'2026-09-12').endDate).toBe('2026-09-12');
    expect(changeAgendaStartDate(original,'2026-09-15').endDate).toBe('2026-09-15');
    const next=changeAgendaStartDate({...original,endDate:'2026-09-14'},'2026-09-16');
    expect(next.endDate).toBe('2026-09-14');
    expect(agendaFormIssue(next,workspace,original)?.field).toBe('endDate');
  });
  it('calcule une durée en heures locales sans dépendre d’un fuseau ou du changement d’heure', () => {
    expect(agendaDuration({...original,startDate:'2026-12-31',startTime:'23:45'},30)).toMatchObject({endDate:'2027-01-01',endTime:'00:15'});
    expect(agendaDuration({...original,startDate:'2026-10-25',startTime:'01:30'},120)).toMatchObject({endDate:'2026-10-25',endTime:'03:30'});
    expect(agendaDuration({...original,startTime:null},30)).toBeNull();
    expect(agendaDuration(original,25)).toBeNull();
  });
  it('conserve un lien historique fermé mais refuse de l’attribuer à une nouvelle fiche', () => {
    const data={...workspace,projects:[{id:'closed',status:'closed'}],employees:[{id:'inactive',active:false}]} as Workspace;
    const draft={...original,projectId:'closed',employeeId:'inactive'};
    expect(agendaFormIssue(draft,data,draft)).toBeUndefined();
    expect(agendaFormIssue(draft,data,original)?.field).toBe('projectId');
    expect(agendaFormIssue({...draft,projectId:null},data,original)?.field).toBe('employeeId');
  });
  it.each([['start_date','startDate'],['end_time','endTime'],['projet/123','projectId'],['collaborateur/123','employeeId']])('traduit le refus %s', (text,field) => expect(agendaNativeIssue(new Error(text))?.field).toBe(field));
  it('refuse de confirmer une relecture de configuration vide', () => {
    expect(()=>requireAgendaWorkspace(workspace)).not.toThrow();
    expect(()=>requireAgendaWorkspace({...workspace,onboardingCompleted:false})).toThrow('agenda');
    expect(()=>requireAgendaWorkspace({...workspace,settings:null})).toThrow('agenda');
  });
});
describe('comparaison des versions du rendez-vous', () => {
  it('réunit les modifications indépendantes sans écraser celles de l’autre fenêtre', () => {
    const mine={...original,notes:'Ma précision'};
    const saved={...stored,title:'Nouvelle visite',location:'Genève',updatedAt:'b'};
    const result=agendaMerge(original,mine,saved);
    expect(result.resolved).toBe(true); expect(result.conflicts).toEqual([]);
    expect(result.merged).toMatchObject({title:'Nouvelle visite',location:'Genève',notes:'Ma précision',isNew:false,expectedUpdatedAt:'b'});
    expect(original.notes).toBe('Apporter les plans');
  });
  it('demande un choix pour chaque conflit et conserve les autres modifications', () => {
    const mine={...original,title:'Mon titre',location:'Mon adresse',notes:'Ma note'};
    const saved={...stored,title:'Titre enregistré',location:'Adresse enregistrée',updatedAt:'b'};
    expect(agendaMerge(original,mine,saved).resolved).toBe(false);
    const partial=agendaMerge(original,mine,saved,{title:'mine'}); expect(partial.resolved).toBe(false);
    const result=agendaMerge(original,mine,saved,{title:'mine',location:'saved'});
    expect(result.resolved).toBe(true); expect(result.merged).toMatchObject({title:'Mon titre',location:'Adresse enregistrée',notes:'Ma note'});
  });
  it('garde les dates et les horaires ensemble pour éviter un mélange incohérent', () => {
    const mine={...original,startTime:'23:00',endTime:'01:00',endDate:'2026-09-14'};
    const saved={...stored,startDate:'2026-09-15',endDate:'2026-09-15',updatedAt:'b'};
    const result=agendaMerge(original,mine,saved,{schedule:'mine'});
    expect(result.conflicts.map(row=>row.group)).toEqual(['schedule']);
    expect(result.merged).toMatchObject({startDate:'2026-09-13',endDate:'2026-09-14',startTime:'23:00',endTime:'01:00'});
  });
  it('ne crée pas de conflit pour des changements identiques ou des horaires masqués', () => {
    expect(agendaMerge(original,{...original,title:'Même titre'},{...stored,title:'Même titre',updatedAt:'b'}).conflicts).toEqual([]);
    const day={...original,allDay:true};
    expect(agendaMerge(day,{...day,startTime:'13:00'},{...stored,allDay:true,startTime:null,endTime:null,updatedAt:'b'}).conflicts).toEqual([]);
  });
});
