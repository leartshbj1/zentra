import {desktopApi} from '../src/bridge';
import type {Workspace} from '../src/types';

// Capture the production functions before mobile-harness installs its preview defaults.
const native={load:desktopApi.loadWorkspace,create:desktopApi.createEntity,update:desktopApi.updateEntity,start:desktopApi.startTimer};
const storeKey='qa.time-draft-recovery.v1';
export function installTimeDraftRecoveryFixture(data:Workspace){
 const query=new URLSearchParams(location.search),company=query.get('timeCompany')||'qa-time-draft-company';
 const saved=JSON.parse(sessionStorage.getItem(storeKey)||'null')||{dbs:{},attempts:[],reads:[],writes:0};
 const seed=()=>({work_notes_scope:company,settings:{company_name:'Atelier de recette',extra_settings_json:JSON.stringify(data.settings)},clients:[{id:'client-qa',name:'Client de recette',company:'Client de recette'}],projects:[{id:'project-time',name:'Projet témoin',client_id:'client-qa',status:'en_cours'}],employees:[{id:'employee-time',name:'Collaborateur témoin',status:'actif',hourly_rate_cents:4500}],project_tasks:[],time_entries:[]});
 saved.dbs[company]??=seed();
 const state:any={...saved,company,mode:'',blockRead:false,hold:false,waiting:false,release:()=>{},oldPayload:null};
 const db=()=>state.dbs[state.company];
 const persist=()=>sessionStorage.setItem(storeKey,JSON.stringify({dbs:state.dbs,attempts:state.attempts,reads:state.reads,writes:state.writes}));
 const commit=(row:any)=>{if(db().time_entries.some((prior:any)=>prior.id===row.id))throw Error('Cet identifiant existe déjà ; aucune nouvelle création.');db().time_entries.push({...structuredClone(row),created_at:'2026-10-03T10:00:00Z',billing_status:'unbilled'});state.writes++;persist();};
 data.workNotesScope=company;data.projects=[{id:'project-time',name:'Projet témoin',clientId:'client-qa',status:'in_progress',address:'',plannedStart:'',plannedEnd:'',actualStart:'',actualEnd:'',budgetCents:0,plannedMinutes:0,notes:''}];data.employees=[{id:'employee-time',name:'Collaborateur témoin',active:true,hourlyCostCents:4500,salaryMode:'hourly',grossSalaryCents:0}] as Workspace['employees'];data.projectTasks=[];
 data.timeEntries=db().time_entries.map((row:any)=>({id:row.id,projectId:row.project_id,taskId:row.task_id,employeeId:row.employee_id,date:row.date,minutes:row.minutes,breakMinutes:row.break_minutes,billable:row.billable,billingRateCents:row.billing_rate_cents,hourlyCostCents:row.cost_rate_cents,note:row.note,status:row.status==='approuve'?'approved':row.status==='verrouille'?'locked':'entered',billingStatus:'unbilled',createdAt:row.created_at}));
 Object.assign(window,{timeDraftRecoveryFixture:{state,persist,configure:(patch:any)=>{Object.assign(state,patch);persist();},unlockReads:()=>{state.blockRead=false;},releaseWrite:()=>{state.hold=false;state.release();},switchCompany:(next:string)=>{state.company=next;if(!state.dbs[next]){state.dbs[next]=seed();state.dbs[next].work_notes_scope=next;}persist();}}});
 (window as any).__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{
  if(command==='get_app_state'||command==='get_workspace'){
   state.reads.push({command,scope:state.company});persist();if(state.blockRead)throw Error('Lecture native de recette interrompue.');
   return command==='get_app_state'?{onboarding_completed:true}:structuredClone(db());
  }
  if(command!=='create_record'||args?.entity!=='time_entries')throw Error(`Native command outside this closed time-entry fixture: ${command}`);
  state.attempts.push({command,args:structuredClone(args),scope:state.company});persist();const mode=state.mode;state.mode='';
  if(state.hold){state.waiting=true;try{await new Promise<void>(resolve=>state.release=resolve);}finally{state.waiting=false;}}
  if(mode==='refuse')throw Error('Création de recette refusée sans commit.');
  if(mode==='old-arrives-refuse'){if(!state.oldPayload)throw Error('Missing explicit old payload');commit(state.oldPayload);throw Error('Nouvelle variante refusée après l’arrivée de l’ancienne.');}
  commit(args.data);if(mode==='ack-unreadable')state.blockRead=true;
  if(mode==='lost')throw Error('ACK de création perdu après commit de recette.');
  return structuredClone(args.data);
 }};
 desktopApi.loadWorkspace=native.load;desktopApi.createEntity=native.create;desktopApi.updateEntity=native.update;desktopApi.startTimer=native.start;persist();
}
