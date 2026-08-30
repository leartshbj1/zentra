import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { BriefcaseBusiness, ExternalLink, LoaderCircle, ShieldCheck } from 'lucide-react';
import { desktopApi } from './bridge';
import type { AppSettings, BusinessProfile, NogaCatalog, NogaSectionCode, Workspace } from './types';
import { Button, ErrorPanel, Field } from './ui';

type EditorProps = {
  profile: BusinessProfile;
  onChange: (profile: BusinessProfile) => void;
  disabled?: boolean;
};

export function BusinessProfileFields({ profile, onChange, disabled = false }: EditorProps) {
  const [catalog, setCatalog] = useState<NogaCatalog | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void desktopApi.getNogaCatalog()
      .then((next) => { if (active) setCatalog(next); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Le catalogue NOGA 2025 local n’a pas pu être chargé.'); });
    return () => { active = false; };
  }, []);

  const selectedSection = useMemo(() => catalog?.sections.find((section) => section.code === profile.nogaSection), [catalog, profile.nogaSection]);
  const patch = (value: Partial<BusinessProfile>) => onChange({ ...profile, ...value });

  return <>
    <div className="form-grid">
      <Field label="Section NOGA 2025" required wide><select value={profile.nogaSection} disabled={disabled || !catalog} onChange={(event) => patch({ nogaSection: event.target.value as NogaSectionCode | '', nogaDivision: '', nogaDetailedCode: '' })} required><option value="">{catalog ? 'Choisir parmi les 22 sections officielles' : 'Chargement du catalogue officiel…'}</option>{catalog?.sections.map((section) => <option key={section.code} value={section.code}>{section.code} · {section.label}</option>)}</select></Field>
      <Field label="Division NOGA 2025" required wide><select value={profile.nogaDivision} disabled={disabled || !selectedSection} onChange={(event) => patch({ nogaDivision: event.target.value, nogaDetailedCode: '' })} required><option value="">{selectedSection ? 'Choisir la division officielle' : 'Choisissez d’abord une section'}</option>{selectedSection?.divisions.map((division) => <option key={division.code} value={division.code}>{division.code} · {division.label}</option>)}</select></Field>
      <Field label="Activité précise" hint="Décrivez votre activité réelle. Cette information reste dans la base locale." required wide><textarea rows={3} value={profile.activityDescription} onChange={(event) => patch({ activityDescription: event.target.value })} maxLength={2000} disabled={disabled} required /></Field>
      <Field label="Code NOGA détaillé" hint="Facultatif : 3, 4 ou 6 chiffres, avec le préfixe de la division." wide><input inputMode="numeric" value={profile.nogaDetailedCode} onChange={(event) => patch({ nogaDetailedCode: event.target.value.replace(/\D/g, '').slice(0, 6) })} pattern={profile.nogaDivision ? `${profile.nogaDivision}(?:\\d|\\d{2}|\\d{4})` : '\\d{3}|\\d{4}|\\d{6}'} disabled={disabled} /></Field>
    </div>
    {error ? <ErrorPanel message={error} /> : null}
    <p className="source-note"><ExternalLink size={14} /> Source : <a href={catalog?.source || 'https://www.kubb-tool.bfs.admin.ch/fr/noga/2025'} target="_blank" rel="noreferrer">Office fédéral de la statistique · KUBB NOGA 2025</a>{catalog?.version ? ` · version ${catalog.version}` : ''}</p>
  </>;
}

function validProfile(profile: BusinessProfile): boolean {
  if (!profile.nogaSection || !/^\d{2}$/.test(profile.nogaDivision) || !profile.activityDescription.trim()) return false;
  if (!profile.nogaDetailedCode) return true;
  return [3, 4, 6].includes(profile.nogaDetailedCode.length) && /^\d+$/.test(profile.nogaDetailedCode) && profile.nogaDetailedCode.startsWith(profile.nogaDivision);
}

export function BusinessProfileGate({ workspace, onSaved }: { workspace: Workspace; onSaved: (workspace: Workspace) => void }) {
  const [profile, setProfile] = useState(workspace.settings!.business);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validProfile(profile)) { setError('Choisissez une section et une division officielles, puis décrivez précisément votre activité.'); return; }
    setBusy(true); setError('');
    try { onSaved(await desktopApi.saveSettings({ ...workspace.settings!, business: { ...profile, activityDescription: profile.activityDescription.trim() } })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Le profil d’activité n’a pas pu être enregistré localement.'); }
    finally { setBusy(false); }
  }

  return <main className="business-profile-gate"><form className="panel business-profile-gate__card" onSubmit={(event) => void submit(event)}><header><span><BriefcaseBusiness size={25} /></span><div><p className="eyebrow">Mise à niveau locale</p><h1>Choisissez votre secteur d’activité</h1><p>Vos données existantes sont conservées. Ce choix adapte uniquement les mots utilisés pour vos chantiers, projets ou dossiers.</p></div></header><div className="info-strip"><ShieldCheck size={17} /><span>Les 22 sections et 87 divisions proviennent du catalogue officiel NOGA 2025 embarqué dans l’application.</span></div><BusinessProfileFields profile={profile} onChange={setProfile} disabled={busy} />{error ? <ErrorPanel message={error} /> : null}<div className="form-actions"><Button type="submit" size="large" disabled={busy || !validProfile(profile)}>{busy ? <LoaderCircle className="spin" size={17} /> : <BriefcaseBusiness size={17} />}{busy ? 'Enregistrement…' : 'Enregistrer et ouvrir mon espace'}</Button></div></form></main>;
}
