import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AppearanceSetting} from '../src/AppearanceSetting';
import {CloudAccountPanel} from '../src/CloudAccountPanel';
import {JoinCompany} from '../src/JoinCompany';
import {DocumentPreviewFrame} from '../src/DocumentPreviewFrame';
import {TouchImagePreview} from '../src/TouchImagePreview';
import PdfAttachmentPreview from '../src/PdfAttachmentPreview';
import {desktopApi} from '../src/bridge';
import {initialOnboardingSettings} from '../src/onboardingDraft';
import {Modal,Button} from '../src/ui';
import {setAppLanguage} from '../src/language';
import '../src/styles.css';import '../src/workspace-design.css';import '../src/mobile.css';import '../src/experience.css';import '../src/workspace-shell.css';import '../src/refined.css';import '../src/projectFilePreview.css';import '../src/touchExperience.css';
const params=new URLSearchParams(location.search);setAppLanguage((params.get('lang')||'fr') as 'fr');
const test=window as unknown as {calls:string[];resolvePoll:()=>void;connect:()=>void};test.calls=[];
let state:any={status:'disconnected'};let count=0;
const team:any={organizationId:'org_test',organizationName:'Atelier de démonstration',role:'owner',canManage:true,profile:null,seats:{planName:'Start',limit:3,used:1,reserved:0,available:2,subscriptionActive:true},members:[{id:'owner',email:'compte.personnel@example.invalid',role:'owner'}],invitations:[]};
test.connect=()=>{state={status:'connected',organizationId:'org_test',organizationName:team.organizationName,role:'owner'};};
desktopApi.getCloudAccountState=async()=>state;
desktopApi.startCloudAccountLink=async()=>{test.calls.push('start');state={status:'pending',userCode:`TEST-${++count}`,authorizationExpiresAt:new Date(Date.now()+600000).toISOString(),intervalSeconds:3};return state;};
desktopApi.openCloudAccountLink=async()=>{test.calls.push('open');};
desktopApi.pollCloudAccountLink=()=>new Promise(resolve=>{const old={...state};test.resolvePoll=()=>resolve(old);});
desktopApi.getCloudTeam=async()=>{test.calls.push('team');return structuredClone(team);};
desktopApi.publishCloudCompany=async()=>{test.calls.push('profile');team.profile={company_name:'Atelier de démonstration'};return {saved:true};};
desktopApi.inviteCloudMember=async(email,role)=>{test.calls.push(`invite:${role}`);if(!team.seats.available)throw new Error('Toutes les places sont utilisées.');team.invitations.push({id:'inv_test',email,role,expiresAt:2000000000});team.seats.reserved++;team.seats.available--;return {invitation:{id:'inv_test',email,role,url:'https://example.invalid/invitation?token=test',expiresAt:2000000000}};};
desktopApi.revokeCloudInvitation=async()=>{team.invitations=[];team.seats.reserved=0;team.seats.available=2;return {revoked:true};};
desktopApi.joinCloudCompany=async()=>{test.calls.push('join');return {} as never;};
// Development-only generated PDF; never uploaded or included in release artifacts.
function pdf(){const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];const stream='BT /F1 24 Tf 30 550 Td (Plan de demonstration) Tj ET';objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);let s='%PDF-1.4\n';const offsets=[0];objects.forEach((o,i)=>{offsets.push(s.length);s+=`${i+1} 0 obj\n${o}\nendobj\n`;});const x=s.length;s+=`xref\n0 6\n0000000000 65535 f \n`+offsets.slice(1).map(o=>`${String(o).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;return new TextEncoder().encode(s);}
const bytes=pdf();
function Fixture(){const [view,setView]=useState(params.get('view')||'account');return <><nav style={{padding:16}}>{['account','join','document','image','pdf','appearance'].map(v=><button key={v} onClick={()=>setView(v)}>{v}</button>)}</nav>
{view==='appearance'&&<AppearanceSetting/>}
{view==='account'&&<CloudAccountPanel settings={initialOnboardingSettings}/>}
{view==='join'&&<JoinCompany onClose={()=>setView('account')} onJoined={()=>setView('joined')}/>}
{view==='joined'&&<p>Entreprise ouverte</p>}
{view==='document'&&<DocumentPreviewFrame title="Devis" number="D-2026-014" customer="Atelier du Lac" total="CHF 2’400.00" finalDocument actions={<Button>Exporter le PDF</Button>} onClose={()=>setView('account')}><article style={{background:'white',padding:48,minHeight:1123,color:'#173d2c'}}><header className="print-header"><h1>Atelier du Lac</h1><h2>Devis D-2026-014</h2></header><table className="print-table" style={{width:'100%',marginTop:80}}><thead><tr><th>Prestation</th><th>Montant CHF</th></tr></thead><tbody>{Array.from({length:15},(_,i)=><tr key={i}><td style={{padding:12}}>Préparation et réalisation — étape {i+1}</td><td>160.00</td></tr>)}</tbody></table><h2 className="print-totals">Total CHF 2’400.00</h2><footer className="print-footer">Merci de votre confiance.</footer></article></DocumentPreviewFrame>}
{(view==='image'||view==='pdf')&&<Modal title="Document du projet" className="attachment-preview-dialog" wide onClose={()=>setView('account')}><div className="attachment-preview"><div className="attachment-preview__content">{view==='image'?<TouchImagePreview name="Plan de démonstration" onError={()=>{throw new Error('image')}} url={'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1100"><rect width="800" height="1100" fill="#fcfbf8"/><path d="M100 200H700V900H100Z M400 200V600H700 M100 600H250" fill="none" stroke="#204938" stroke-width="6"/><text x="100" y="100" font-size="35">Atelier du Lac — Plan</text></svg>')}/>:<PdfAttachmentPreview name="Plan de démonstration" bytes={bytes}/>}</div><footer className="attachment-preview__footer"><Button>Enregistrer une copie</Button></footer></div></Modal>}
</>;}createRoot(document.getElementById('root')!).render(<Fixture/>);

import '../src/appearance';
import '../src/dark.generated.css';
import '../src/dark.css';
