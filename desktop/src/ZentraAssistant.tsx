import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, BookOpen, Check, Copy, MessageCircle, Square, Trash2 } from 'lucide-react';
import { AssistantContext, type AssistantScreen } from './assistantContext';
import { assistantPrompt, selectAssistantGuides, type AssistantMessage } from './assistantGuide';
import { localModelInstallation } from './localModelInstallation';
import { payrollLocalAi } from './payrollLocalAi';
import { LocalAssistantSetup } from './LocalAssistantSetup';
import { Modal } from './ui';

type Turn = AssistantMessage & { id: string; incomplete?: boolean; source?: 'guide' | 'qwen' };
export function ZentraAssistantProvider({ children }: { children: ReactNode }) {
  const registry = useRef(new Map<string, { priority: number; value: AssistantScreen }>());
  const [opened,setOpened]=useState(false);
  const [screen,setScreen]=useState<AssistantScreen>({screen:'Accueil Zentra'});
  const [messages,setMessages]=useState<Turn[]>([]);
  const [question,setQuestion]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [progress,setProgress]=useState('');
  const [copied,setCopied]=useState('');
  const model=useSyncExternalStore(localModelInstallation.subscribe,localModelInstallation.getSnapshot);
  const pending=useRef(false);
  const request=useRef(0);
  const scope=useRef('');
  const scrollRef=useRef<HTMLDivElement>(null);
  const followOutput=useRef(true);
  const currentScreen=useCallback(()=>{
    const values=[...registry.current.values()].sort((a,b)=>a.priority-b.priority).map(item=>item.value);
    return values.reduce<AssistantScreen>((result,value)=>({...result,...value,facts:{...result.facts,...value.facts}}),{screen:'Accueil Zentra'});
  },[]);
  const open=useCallback(()=>{
    void localModelInstallation.inspect();
    const next=currentScreen();
    if (scope.current !== (next.scope ?? next.screen)) { setMessages([]); setQuestion(''); scope.current=next.scope ?? next.screen; }
    setScreen(next); setError(''); setOpened(true);
  },[currentScreen]);
  const context=useMemo(()=>({open,register:(id:string,priority:number,value:AssistantScreen)=>{registry.current.set(id,{priority,value});},remove:(id:string)=>{registry.current.delete(id);}}),[open]);
  useEffect(()=>{
    if (opened || busy || model.phase === 'installing') return;
    const timer=window.setTimeout(()=>payrollLocalAi.releaseIfIdle(),60_000);
    return ()=>window.clearTimeout(timer);
  },[opened,busy,model.phase]);
  useEffect(()=>{
    if (followOutput.current && scrollRef.current) scrollRef.current.scrollTop=scrollRef.current.scrollHeight;
  },[messages,progress]);
  function stop() { if (!pending.current) return; request.current++; pending.current=false; payrollLocalAi.cancel(); setBusy(false); setProgress(''); setMessages(current=>current.map((message,index)=>index===current.length-1 && message.role==='assistant' ? {...message,incomplete:true} : message)); }
  function close() { stop(); setOpened(false); }
  async function ask(value=question) {
    const text=value.trim(); if (!text || pending.current || model.phase !== 'installed') return;
    const next=currentScreen(); const requestId=++request.current;
    const history=scope.current === (next.scope ?? next.screen) ? messages.filter(message=>!message.incomplete) : [];
    scope.current=next.scope ?? next.screen; setScreen(next);
    const id=crypto.randomUUID();
    pending.current=true; setBusy(true); setError(''); setQuestion(''); setProgress('Qwen prépare votre réponse…'); followOutput.current=true;
    setMessages([...history.slice(-10),{id:crypto.randomUUID(),role:'user',content:text},{id,role:'assistant',content:''}]);
    const unsubscribe=payrollLocalAi.onProgress(value=>setProgress(value.label));
    try {
      const result=await payrollLocalAi.chat({question:text,screen:next.screen,facts:next.facts??{},history}, output=>{
        if (requestId===request.current) { setProgress(''); setMessages(current=>current.map(message=>message.id===id ? {...message,content:output} : message)); }
      });
      if (requestId===request.current) setMessages(current=>current.map(message=>message.id===id ? {...message,content:result.output,incomplete:result.truncated,source:result.source} : message));
    } catch(reason) {
      if (requestId===request.current) { setError(reason instanceof Error ? reason.message : 'La réponse n’a pas pu être préparée. Réessayez.'); setQuestion(text); setMessages(current=>current.filter(message=>message.id!==id)); }
    } finally { unsubscribe(); if (requestId===request.current) { pending.current=false; setBusy(false); setProgress(''); } }
  }
  const guides=selectAssistantGuides(messages.filter(m=>m.role==='user').at(-1)?.content ?? screen.screen, screen.screen);
  return <AssistantContext.Provider value={context}>{children}
    {!opened && createPortal(<button type="button" className="assistant-launcher" onClick={open} aria-label="Demander à l’assistant Zentra"><MessageCircle size={21}/><span>Assistant</span></button>,document.body)}
    {opened && <Modal title="Assistant Zentra" description="Votre aide locale, au fil de votre travail." onClose={close} className="zentra-assistant-dialog" assistantHelp={false}>
      <div className="assistant-context"><span><span className="assistant-status-dot"/>{screen.screen}</span><details><summary>Contexte utilisé</summary><p>Ces informations restent sur cet appareil. Aucun dossier complet n’est transmis.</p><dl>{Object.entries(assistantPrompt('',screen.screen,screen.facts??{},[]).facts).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value == null ? 'Non renseigné' : typeof value === 'boolean' ? value ? 'Oui' : 'Non' : String(value)}</dd></div>)}</dl></details></div>
      {model.phase !== 'installed' && <LocalAssistantSetup/>}
      {model.phase === 'installed' && <p className="assistant-local-note">Qwen fonctionne sur cet appareil. Il explique les étapes ; vous gardez la décision et la validation.</p>}
      <div ref={scrollRef} className="assistant-conversation" role="log" aria-label="Conversation avec l’assistant" aria-live="off" onScroll={event=>{const node=event.currentTarget;followOutput.current=node.scrollHeight-node.scrollTop-node.clientHeight<60;}}>
        {!messages.length && <div className="assistant-welcome"><MessageCircle size={30}/><h3>Comment puis-je vous aider ?</h3><p>Décrivez ce que vous voulez faire ou le point qui vous bloque.</p><div className="assistant-suggestions">{['Explique-moi cette étape simplement.','Comment créer une fiche de salaire ?','Comment configurer la caisse de pension ?'].map(value=><button type="button" key={value} disabled={busy} onClick={()=>setQuestion(value)}>{value}</button>)}</div></div>}
        {messages.map(message=><div className={`assistant-message assistant-message--${message.role}`} key={message.id}><span>{message.role==='user' ? 'Vous' : message.source==='guide' ? 'Guide vérifié Zentra' : 'Réponse de Qwen'}</span><p>{message.content || (busy ? progress || 'Préparation…' : 'Réponse interrompue.')}</p>{message.incomplete && <small>Réponse interrompue ou abrégée. Demandez une précision avant de vous appuyer dessus.</small>}{message.role==='assistant' && message.content && !busy && <button type="button" className="assistant-copy" onClick={()=>{void navigator.clipboard.writeText(message.content).then(()=>setCopied(message.id)).catch(()=>setError('La copie n’est pas disponible. Sélectionnez le texte de la réponse.'));}} aria-label="Copier la réponse">{copied===message.id ? <Check size={14}/> : <Copy size={14}/>}</button>}</div>)}
      </div>
      <span className="sr-only" role="status">{busy ? 'L’assistant prépare une réponse.' : messages.at(-1)?.role==='assistant' ? 'La réponse de l’assistant est disponible.' : ''}</span>
      {error && <p className="assistant-error" role="alert">{error}</p>}
      <details className="assistant-guide"><summary><BookOpen size={16}/> Guide Zentra et raccourcis</summary>{guides.map(guide=><section key={guide.id}><h4>{guide.title}</h4><p>{guide.text}</p></section>)}{screen.actions?.map(action=><button type="button" key={action.label} className="button button--secondary" disabled={busy} onClick={()=>{close(); action.run();}}>{action.label}</button>)}</details>
      <form className="assistant-composer" onSubmit={event=>{event.preventDefault();void ask();}}><label className="sr-only" htmlFor="zentra-assistant-question">Votre question</label><textarea id="zentra-assistant-question" value={question} onChange={event=>setQuestion(event.target.value)} placeholder="Posez votre question…" maxLength={900} rows={2} disabled={busy} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void ask();}}}/>{busy ? <button type="button" onClick={stop} aria-label="Arrêter la réponse"><Square size={19}/></button> : <button type="submit" disabled={!question.trim()||model.phase!=='installed'} aria-label="Envoyer la question"><ArrowUp size={21}/></button>}</form>
      <div className="assistant-footer"><small>Pour les chiffres et les cotisations, vérifiez les calculs Zentra et vos documents.</small><button type="button" disabled={busy||!messages.length} onClick={()=>{setMessages([]);setError('');}} aria-label="Effacer la conversation"><Trash2 size={16}/></button></div>
    </Modal>}
  </AssistantContext.Provider>;
}
