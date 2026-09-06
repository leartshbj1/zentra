import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Download, FileCheck2, LoaderCircle, Plus, Trash2 } from 'lucide-react';
import { desktopApi } from './bridge';
import { Button, Field } from './ui';
import type { Workspace } from './types';
import { formatMoney } from './utils';
import { certificateAllowedBoxes, certificateBoxes, certificateCents, certificateInput, certificateRows, type CertificateDraft, type CertificateIdentity, type CertificateInput } from './salaryCertificate';
import './SalaryCertificates.css';

function CertificateAmount({ value, label, onChange }: { value: number; label: string; onChange: (cents: number) => void }) {
  const [raw, setRaw] = useState(String(value / 100));
  useEffect(() => { setRaw(current => certificateCents(current) === value ? current : String(value / 100)); }, [value]);
  return <input type="text" inputMode="decimal" required aria-label={label} value={raw} onChange={event => {
    setRaw(event.target.value);
    const cents = certificateCents(event.target.value);
    event.target.setCustomValidity(cents === null ? 'Indiquez un montant CHF avec au maximum deux décimales.' : '');
    if (cents !== null) onChange(cents);
  }} />;
}

export function SalaryCertificates({ workspace, disabled }: { workspace: Workspace; disabled: boolean }) {
  const [employeeId, setEmployeeId] = useState(workspace.employees[0]?.id ?? '');
  const [year, setYear] = useState(new Date().getFullYear());
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState<CertificateDraft | null>(null);
  const [input, setInput] = useState<CertificateInput | null>(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pages, setPages] = useState<string[]>([]);
  const stepHeading = useRef<HTMLOListElement>(null);
  const previousStep = useRef(0);
  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    const frame = requestAnimationFrame(() => stepHeading.current?.scrollIntoView({ block: 'start', behavior: 'instant' }));
    return () => cancelAnimationFrame(frame);
  }, [step]);
  const rows = draft && input ? certificateRows(draft, input.sourceIds) : [];
  const exceptional = draft && input && draft.sources.some(source => input.sourceIds.includes(source.id) !== source.defaultIncluded || (!source.paymentDate && input.sourceIds.includes(source.id)) || (source.paymentDate && source.period.slice(0,4) !== source.paymentDate.slice(0,4)));
  function selectSource(id: string, included: boolean) {
    if (!draft || !input) return;
    const sourceIds = included ? [...input.sourceIds, id] : input.sourceIds.filter(value => value !== id);
    patch({ sourceIds, allocations: Object.fromEntries(certificateRows(draft, sourceIds).map(row => [row.id, input.allocations[row.id] ?? row.proposedBox])) });
  }
  useEffect(() => {
    let active = true;
    setDraft(null); setInput(null); setStep(0); setPages([]); setError(''); setNotice('');
    if (!employeeId || !Number.isInteger(year) || year < 2000 || year > 2099) { setLoading(false); return; }
    setLoading(true);
    void desktopApi.salaryCertificateDraft(employeeId, year).then(value => {
      if (active) { setDraft(value); setInput(certificateInput(value)); }
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [employeeId, year, reload]);
  function patch(update: Partial<CertificateInput>) { setInput(value => value ? { ...value, ...update, reviewed: false } : value); setNotice(''); }
  function identity(key: keyof CertificateIdentity, value: string) { if (input) patch({ identity: { ...input.identity, [key]: value } }); }
  async function next() {
    if (!input) return;
    if (step === 0) { setStep(1); setError(''); return; }
    setBusy(true); setError('');
    try {
      const bytes = await desktopApi.salaryCertificatePreview(input);
      const { renderPdfPages } = await import('./localPdfPreview');
      setPages((await renderPdfPages(new Uint8Array(bytes), 20)).pages); setStep(2);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function exportPdf() {
    if (!input) return;
    setBusy(true); setError('');
    try { if (await desktopApi.exportSalaryCertificate(input)) setNotice('Certificat de salaire exporté. Une trace de l’édition est conservée dans le journal local.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <section className="salary-certificates" aria-label="Certificats de salaire annuels">
    <header><div><h2>Certificats de salaire</h2><p>Le récapitulatif annuel de chaque collaborateur, sur le formulaire officiel suisse.</p></div><FileCheck2 size={25} aria-hidden="true" /></header>
    <div className="salary-certificates__selection">
      <Field label="Collaborateur"><select aria-label="Collaborateur du certificat" value={employeeId} disabled={busy || disabled} onChange={event => setEmployeeId(event.target.value)}><option value="">Choisir un collaborateur</option>{workspace.employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}{employee.active ? '' : ' · ancien collaborateur'}</option>)}</select></Field>
      <Field label="Année"><input aria-label="Année du certificat" type="number" min="2000" max="2099" value={year} disabled={busy || disabled} onChange={event => setYear(Number(event.target.value))} /></Field>
      <Button type="button" variant="ghost" disabled={busy || loading || disabled} onClick={() => setReload(value => value + 1)}>Recharger les fiches</Button>
    </div>
    {loading ? <p role="status"><LoaderCircle className="spin" size={16} /> Lecture des fiches de l’année…</p> : null}
    {error ? <p className="salary-certificates__error" role="alert">{error}</p> : null}
    {notice ? <p className="salary-certificates__notice" role="status">{notice}</p> : null}
    {draft && input ? <form onSubmit={event => { event.preventDefault(); void next(); }}>
      <ol ref={stepHeading} className="salary-certificates__steps" aria-label="Étapes du certificat">{['Identité','Montants','Aperçu'].map((label,index) => <li key={label} aria-current={index === step ? 'step' : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
      {step === 0 ? <div className="form-grid">
        <Field label="Nom complet" required><input required value={input.identity.name} onChange={event => identity('name', event.target.value)} /></Field>
        <Field label="Numéro AVS" required><input required placeholder="756.1234.5678.97" value={input.identity.avsNumber} onChange={event => identity('avsNumber', event.target.value)} /></Field>
        <Field label="Date de naissance" required><input required type="date" value={input.identity.birthDate} onChange={event => identity('birthDate', event.target.value)} /></Field>
        <Field label="Adresse du collaborateur" required><textarea required rows={3} value={input.identity.address} onChange={event => identity('address', event.target.value)} /></Field>
        <Field label="Période salariée · du" required><input required type="date" value={input.identity.periodStart} onChange={event => identity('periodStart', event.target.value)} /></Field>
        <Field label="Au" required><input required type="date" value={input.identity.periodEnd} onChange={event => identity('periodEnd', event.target.value)} /></Field>
        <Field label="Employeur · responsable, adresse et téléphone" required><textarea required rows={5} value={input.identity.employerContact} onChange={event => identity('employerContact', event.target.value)} /></Field>
        <Field label="Lieu et date d’établissement" required><input required value={input.identity.placeDate} onChange={event => identity('placeDate', event.target.value)} /></Field>
        <div className="salary-certificates__checks field--wide"><label><input type="checkbox" checked={input.freeTransport} onChange={event => patch({ freeTransport: event.target.checked })} /> F · Transport gratuit entre le domicile et le travail</label><label><input type="checkbox" checked={input.meals} onChange={event => patch({ meals: event.target.checked })} /> G · Repas à la cantine ou chèques-repas</label></div>
      </div> : step === 1 ? <div className="salary-certificates__amounts">
        <p>{input.sourceIds.length} fiche(s) rattachée(s) à {year}, à partir des valeurs comptabilisées.</p>
        <details className="salary-certificates__sources" open={Boolean(exceptional)}><summary>Vérifier les fiches et leur année fiscale</summary><p>Un salaire connu et dont le paiement est certain appartient à l’année de la prestation, même s’il est payé en janvier. Un bonus incertain ou déterminé plus tard peut relever de l’année du paiement. Vérifiez qu’il ne figure pas déjà sur un autre certificat.</p>{draft.sources.map(source => <label key={source.id}><input type="checkbox" checked={input.sourceIds.includes(source.id)} onChange={event => selectSource(source.id, event.target.checked)} /><span>Fiche de {source.period}<small>{source.paymentDate ? `Payée le ${source.paymentDate}` : 'Comptabilisée · paiement à vérifier'}</small></span></label>)}</details>
        {exceptional ? <Field label="Justification du rattachement fiscal" required wide><textarea required minLength={10} maxLength={600} rows={3} value={input.realizationNote} onChange={event => patch({ realizationNote: event.target.value })} placeholder="Ex. Salaire de décembre connu et paiement certain au 31 décembre, versé en janvier." /></Field> : null}
        {draft.unpaidCount ? <p className="salary-certificates__warning">{draft.unpaidCount} fiche(s) de cette période ne sont pas comptabilisées et ne sont pas incluses. Finalisez-les ou complétez les prestations manquantes avant le certificat définitif.</p> : null}
        <div className="salary-certificates__rows">{rows.map(row => <div key={row.id} className="salary-certificates__row"><div><strong>{row.label}</strong><small>{row.count} ligne{row.count > 1 ? 's' : ''} · {row.kind === 'earning' ? 'Rémunération' : row.kind === 'deduction' ? 'Retenue' : 'Frais'}</small></div><span>{formatMoney(row.amountCents)}</span>{row.fixedBox ? <p>{certificateBoxes[row.proposedBox]}</p> : <select required aria-label={`Rubrique annuelle · ${row.label}`} value={input.allocations[row.id] ?? ''} onChange={event => patch({ allocations: { ...input.allocations, [row.id]: event.target.value } })}><option value="">Choisir la rubrique</option>{certificateAllowedBoxes(row.kind).map(box => <option key={box} value={box}>{certificateBoxes[box]}</option>)}</select>}</div>)}</div>
        <section className="salary-certificates__extras"><h3>Prestations complémentaires</h3><p>Ajoutez uniquement les prestations absentes des fiches listées ci-dessus, par exemple un avantage en nature.</p>
          {input.extras.map((extra,index) => <div className="salary-certificates__extra" key={index}><input required aria-label={`Libellé complément ${index+1}`} placeholder="Nature de la prestation" value={extra.label} onChange={event => patch({ extras: input.extras.map((row,i) => i === index ? { ...row, label: event.target.value } : row) })} /><select required aria-label={`Rubrique complément ${index+1}`} value={extra.boxId} onChange={event => patch({ extras: input.extras.map((row,i) => i === index ? { ...row, boxId: event.target.value } : row) })}><option value="">Rubrique</option>{Object.entries(certificateBoxes).filter(([key]) => key !== 'exclude').map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select><CertificateAmount label={`Montant CHF complément ${index+1}`} value={extra.amountCents} onChange={amountCents => patch({ extras: input.extras.map((row,i) => i === index ? { ...row, amountCents } : row) })} /><Button type="button" variant="ghost" aria-label={`Retirer le complément ${index+1}`} onClick={() => patch({ extras: input.extras.filter((_,i) => i !== index) })}><Trash2 size={16} /></Button></div>)}
          <Button type="button" variant="secondary" onClick={() => patch({ extras: [...input.extras, { boxId: '', label: '', amountCents: 0 }] })}><Plus size={16} /> Ajouter une prestation</Button>
        </section>
        <div className="form-grid"><Field label="14 · Autres prestations salariales accessoires" wide><input maxLength={140} value={input.benefits} onChange={event => patch({ benefits: event.target.value })} /></Field><Field label="15 · Observations" wide><textarea rows={2} maxLength={180} value={input.remarks} onChange={event => patch({ remarks: event.target.value })} /></Field></div>
        <label className="salary-certificates__check"><input type="checkbox" checked={input.effectiveExpensesAttested} onChange={event => patch({ effectiveExpensesAttested: event.target.checked })} /> Les frais effectifs de voyage, repas et nuitées respectent les conditions du chiffre marginal 52 du guide AFC (case 13.1.1).</label>
        <p className="salary-certificates__help">Le salaire net fiscal (ch. 11) est le brut, moins les rubriques 9 et 10. L’impôt à la source est indiqué séparément au chiffre 12 selon les fiches payées dans l’année ; complétez les éventuels arriérés ou remboursements avec leur motif.</p>
      </div> : <div className="salary-certificates__preview">
        {pages.map((page,index) => <img key={index} src={page} alt={`Certificat de salaire ${year} · aperçu page ${index+1}`} />)}
        <label className="salary-certificates__check"><input type="checkbox" checked={input.reviewed} disabled={busy || disabled} onChange={event => setInput({ ...input, reviewed: event.target.checked })} /> Je confirme les coordonnées du responsable, les rubriques, le rattachement fiscal et l’intégralité des prestations de l’année, y compris celles saisies hors Zentra.</label><p>À remettre au collaborateur après contrôle et signature de l’employeur.</p>
      </div>}
      <footer className="salary-certificates__actions">{step > 0 ? <Button type="button" variant="ghost" disabled={busy || disabled} onClick={() => { setStep(value => value - 1); patch({}); setError(''); }}><ArrowLeft size={16} /> Retour</Button> : <span />}{step < 2 ? <Button type="submit" disabled={busy || disabled}>{busy ? <LoaderCircle className="spin" size={16} /> : null}{step === 0 ? 'Vérifier les montants' : 'Voir le certificat'}<ArrowRight size={16} /></Button> : <Button type="button" disabled={!input.reviewed || busy || disabled} onClick={() => void exportPdf()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />} Exporter le certificat PDF</Button>}</footer>
    </form> : null}
    <p className="salary-certificates__source"><a href="https://www.estv.admin.ch/fr/certificat-de-salaire-et-attestation-de-rentes" target="_blank" rel="noreferrer">Formulaire et instructions officiels AFC / CSI</a> · L’export reste local ; aucun envoi à l’administration n’est effectué.</p>
  </section>;
}
