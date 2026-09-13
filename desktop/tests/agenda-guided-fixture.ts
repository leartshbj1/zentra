import { desktopApi } from '../src/bridge';
import { refreshWorkspaceAfterMutation } from '../src/workspaceMutation';
import { requireAgendaWorkspace } from '../src/agendaForm';
import { todayIso } from '../src/utils';
import type { AgendaEvent, Workspace } from '../src/types';

export function installAgendaGuidedFixture(workspace: Workspace) {
  const saved = sessionStorage.getItem('agenda-guided-workspace');
  if (saved) Object.assign(workspace,JSON.parse(saved));
  else {
    workspace.agendaEvents=[];
    workspace.projects=[{...workspace.projects[0],id:'agenda-project',name:'Projet de recette',status:'in_progress'}] as Workspace['projects'];
    workspace.employees=[{id:'agenda-person',name:'Noé de recette',active:true}] as Workspace['employees'];
  }
  const stored=structuredClone(workspace);
  const state={ stored, today:todayIso(), writes:0, attempts:0, deletes:0, deleteAttempts:0, reject:'', hold:false, release:()=>{}, refresh:false, failures:0, empty:false, revision:Date.now() };
  const persist=()=>sessionStorage.setItem('agenda-guided-workspace',JSON.stringify(stored));
  const stamp=()=>new Date(++state.revision).toISOString();
  desktopApi.loadWorkspace=async()=>{
    if(state.failures>0) {state.failures--;throw new Error('Lecture de l’agenda interrompue.');}
    if(state.empty) return {...structuredClone(stored),onboardingCompleted:false,settings:null};
    return structuredClone(stored);
  };
  const finish=async()=>{
    persist();
    if(state.refresh) {state.refresh=false;state.failures=3;}
    return refreshWorkspaceAfterMutation(async()=>{const next=await desktopApi.loadWorkspace();requireAgendaWorkspace(next);return next;});
  };
  const before=async()=>{
    if(state.hold) await new Promise<void>(resolve=>{state.release=resolve;});
    if(state.reject) throw new Error(state.reject);
  };
  desktopApi.saveAgendaEvent=async input=>{
    state.attempts++;await before();
    const previous=stored.agendaEvents.find(row=>row.id===input.id);
    if(previous && previous.updatedAt!==input.expectedUpdatedAt) throw new Error('Ce rendez-vous a été modifié dans une autre fenêtre. Rechargez l’agenda.');
    if(!previous && !input.isNew) throw new Error('agenda_events/événement absent');
    const next={...input,createdAt:previous?.createdAt||stamp(),updatedAt:stamp(),startTime:input.allDay?null:input.startTime,endTime:input.allDay?null:input.endTime} as AgendaEvent;
    stored.agendaEvents=[...stored.agendaEvents.filter(row=>row.id!==input.id),next];state.writes++;
    return finish();
  };
  desktopApi.deleteAgendaEvent=async(id,version)=>{
    state.deleteAttempts++;await before();
    const previous=stored.agendaEvents.find(row=>row.id===id);
    if(previous && previous.updatedAt!==version) throw new Error('Ce rendez-vous a été modifié dans une autre fenêtre. Rechargez l’agenda avant de le supprimer.');
    stored.agendaEvents=stored.agendaEvents.filter(row=>row.id!==id);state.deletes++;
    return finish();
  };
  Object.assign(window,{agendaFixture:state,changeAgendaFixture:(patch:Partial<AgendaEvent>)=>{
    const event=stored.agendaEvents[0];Object.assign(event,patch,{updatedAt:stamp()});persist();
  }});
}
