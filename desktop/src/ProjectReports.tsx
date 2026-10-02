import { t, useAppLanguage } from './language';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Download, ChevronRight, ChevronDown } from 'lucide-react';
import type { Workspace } from './types';
import { formatMoney, projectFinancials, errorMessage } from './utils';
import { Button, EmptyState, StatusBadge } from './ui';
import { desktopApi } from './bridge';
import { PdfExportReceipt } from './PdfExportReceipt';
import type { PdfExportReceipt as Receipt } from './pdfExportDelivery';
import { buildProjectReport, recentReportProjects, reportPresets, reportSections, type ReportPreset, type ReportSectionKey } from './projectReport';
import './ProjectReports.css';

export function ReportsScreen({workspace,onOpenAccounting,onOpenProjects}:{workspace:Workspace;onOpenAccounting:()=>void;onOpenProjects?:()=>void}) {
  const language=useAppLanguage();
  const [chosen,setChosen]=useState('');
  const [preset,setPreset]=useState<ReportPreset>('summary');
  const [sections,setSections]=useState<ReportSectionKey[]>(['overview']);
  const [author,setAuthor]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [receipt,setReceipt]=useState<{projectId:string;result:Receipt}|null>(null);
  const [query,setQuery]=useState('');
  const [limit,setLimit]=useState(20);
  const flight=useRef(false);
  const projects=useMemo(()=>recentReportProjects(workspace),[workspace,language]);
  const project=workspace.projects.find(p=>p.id===chosen) ?? (workspace.projects.length===1 ? workspace.projects[0] : undefined);
  const lifetime=useRef({mounted:false,generation:0,scope:workspace.workNotesScope,projectId:project?.id});
  useLayoutEffect(()=>{
    lifetime.current={mounted:true,generation:lifetime.current.generation+1,scope:workspace.workNotesScope,projectId:project?.id};
    flight.current=false;setBusy(false);setReceipt(null);setError('');
    return()=>{lifetime.current={...lifetime.current,mounted:false,generation:lifetime.current.generation+1};};
  },[workspace.workNotesScope,project?.id]);
  const report=useMemo(()=>project ? buildProjectReport(workspace,project,sections,{preset,author}) : null,[workspace,project,sections,preset,author,language]);
  const figures=useMemo(()=>project ? projectFinancials(project,workspace.invoices,workspace.payments,workspace.timeEntries,workspace.expenses,workspace.supplierInvoices,workspace.supplierCreditNotes) : null,[workspace,project]);
  const matches=projects.filter(p=>p.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const forClient=preset==='client';
  function choose(id:string) {setChosen(id);setReceipt(null);setError('');}
  function choosePreset(value:ReportPreset) {setPreset(value);setSections([...reportPresets[value].sections] as ReportSectionKey[]);setReceipt(null);setError('');}
  async function exportPdf() {
    if(!report || !project || !sections.length || flight.current || busy || !lifetime.current.mounted)return;
    const origin={...lifetime.current},projectId=project.id;
    const isCurrent=()=>lifetime.current.mounted && lifetime.current.generation===origin.generation && lifetime.current.scope===origin.scope && lifetime.current.projectId===projectId;
    if(!isCurrent())return;
    flight.current=true;setBusy(true);setError('');setReceipt(null);
    try {
      const result=await desktopApi.exportProjectReportPdf(report,origin.scope,isCurrent);
      if(result && isCurrent())setReceipt({projectId,result});
    } catch(reason) {
      if(isCurrent())setError(errorMessage(reason,'Export du rapport impossible.'));
    } finally {if(isCurrent()){flight.current=false;setBusy(false);}}
  }
  if(!projects.length)return <EmptyState icon={<BarChart3/>} title={t('Vos rapports de projet')} text={t('Créez un projet pour réunir son activité et ses documents dans un rapport.')} actionLabel={onOpenProjects ? t('Voir les projets') : undefined} onAction={onOpenProjects}/>;
  return <div className={`project-reports${project ? ' project-reports--selected' : ''}`}>
    <div className={`project-reports__layout${projects.length===1?' project-reports__layout--single':''}`}>
      {projects.length>1 && <aside className="project-reports__picker" aria-label={t('Choisir un projet')}>
        <label className="project-reports__mobile-picker-label">{t('Projet')}
          <select className="project-reports__mobile-picker" aria-label={t('Choisir un projet')} value={project?.id ?? ''} disabled={busy} onChange={e=>choose(e.target.value)}>
            <option value="">{t('Choisir un projet')}</option>
            {projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="project-reports__search">{t('Rechercher un projet')}
          <input type="search" value={query} disabled={busy} onChange={e=>{setQuery(e.target.value);setLimit(20);}} placeholder={t('Nom du projet')}/>
        </label>
        <div className="project-reports__project-list">
          <p className="project-reports__sort-note">{t('Activité récente en premier')}</p>
          {matches.slice(0,limit).map(p=><button type="button" disabled={busy} key={p.id} aria-pressed={p.id===project?.id} onClick={()=>choose(p.id)}>
            <span>{p.name}<small>{workspace.clients.find(c=>c.id===p.clientId)?.company || workspace.clients.find(c=>c.id===p.clientId)?.name}</small></span><ChevronRight size={17} aria-hidden="true"/>
          </button>)}
          {!matches.length && <p role="status">{t('Aucun projet trouvé. Modifiez votre recherche.')}</p>}
          {matches.length>limit && <Button variant="ghost" disabled={busy} onClick={()=>setLimit(value=>value+20)}>{t('Afficher plus de projets')}</Button>}
        </div>
      </aside>}
      <section className="project-reports__detail" aria-label={t('Aperçu du rapport')}>
        {project && report && figures ? <>
          <header className="project-reports__title"><div><h2>{project.name}</h2><StatusBadge status={project.status}/></div>
            <Button disabled={busy || !sections.length} onClick={()=>void exportPdf()}><Download size={17} aria-hidden="true"/>{t(busy?'Création du PDF…':'Exporter le PDF')}</Button>
          </header>
          <div className="project-reports__configuration"><div className="project-reports__composition">
            <label>{t('Type de rapport')}
              <span className="project-reports__preset-control">
                <select aria-label={t('Type de rapport')} value={preset} disabled={busy} onChange={e=>choosePreset(e.target.value as ReportPreset)}>{Object.entries(reportPresets).map(([key,value])=><option key={key} value={key}>{t(value.label)}</option>)}</select>
                <span aria-hidden="true">{t(reportPresets[preset].label)}<ChevronDown size={17}/></span>
              </span>
            </label>
            <p>{t(reportPresets[preset].description)}</p>
          </div>
          <details className="project-reports__customize"><summary>{t('Personnaliser le contenu')}</summary>
            <fieldset className="project-reports__sections" disabled={busy}><legend>{t('Dans votre rapport')}</legend>
              {Object.entries(reportSections).filter(([key])=>!forClient || reportPresets.client.sections.some(allowed=>allowed===key)).map(([key,label])=><label key={key}>
                <input type="checkbox" checked={sections.includes(key as ReportSectionKey)} onChange={e=>{setReceipt(null);setSections(current=>e.target.checked ? [...current,key as ReportSectionKey] : current.filter(k=>k!==key));}}/>{t(label)}
              </label>)}
            </fieldset>
            <label className="project-reports__author">{t('Préparé par (facultatif)')}<input value={author} maxLength={120} disabled={busy} onChange={e=>{setAuthor(e.target.value);setReceipt(null);}} autoComplete="name"/></label>
          </details></div>
          <dl className="project-reports__figures">
            <div><dt>{t('Facturé hors TVA')}</dt><dd>{figures.invoicedNetLabel}</dd></div>
            {!forClient && <><div><dt>{t('Coûts enregistrés')}</dt><dd>{formatMoney(figures.laborCost+figures.expenseNet)}</dd></div>
              <div><dt>{t('Marge de gestion')}</dt><dd>{figures.marginUnavailableReason ? t(figures.marginUnavailableReason) : figures.hasActivity ? formatMoney(figures.margin) : '—'}</dd></div></>}
          </dl>
          {!forClient && <p className="project-reports__scope">{t('La marge tient compte des coûts enregistrés, pas des coûts encore inconnus.')}</p>}
          {!forClient && figures.purchaseCostReviewCount>0 && <Button variant="secondary" onClick={onOpenAccounting}>{t('Contrôler les achats')}</Button>}
          {!sections.length && <p role="status">{t('Choisissez au moins une rubrique pour exporter le rapport.')}</p>}
          {error && <p role="alert">{t(error)}</p>}
          {receipt?.projectId===project.id && <PdfExportReceipt result={receipt.result} disabled={busy} onBusyChange={setBusy}/>}
          <div className="project-reports__preview-heading"><h3>{t('Aperçu du rapport')}</h3><p className="project-reports__scope">{report.subtitle}</p></div>
          <div className="project-reports__preview" key={project.id}>
            {report.sections.map((section,index)=><details key={`${index}-${section.title}`} open={index===0}>
              <summary>{section.title}</summary>
              <div className="project-reports__table" tabIndex={0} role="region" aria-label={section.title}><table>
                <thead><tr>{section.headers.map(header=><th key={header} scope="col">{header}</th>)}</tr></thead>
                <tbody>{section.rows.map((row,i)=><tr key={i}>{row.map((cell,j)=><td key={j}>{cell}</td>)}</tr>)}</tbody>
              </table></div>
            </details>)}
          </div>
        </> : <div className="project-reports__empty"><BarChart3 size={36} aria-hidden="true"/><h2>{t('Quel projet souhaitez-vous examiner ?')}</h2><p>{t('Choisissez un projet pour voir immédiatement sa synthèse.')}</p></div>}
      </section>
    </div>
  </div>;
}
