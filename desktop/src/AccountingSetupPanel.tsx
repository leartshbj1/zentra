import { useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, Landmark } from 'lucide-react';
import type { Account, AccountingContinuity, AccountingSettings } from './types';
import { accountingMappingIssues, type MappingField, type MappingGroup } from './accountingSetup';
import { Button, Field, SectionHeading } from './ui';
import './accounting-setup.css';

const groups: Array<[MappingGroup, string, string]> = [
  ['sales', 'Ventes et banque', 'Facturer et suivre les encaissements.'],
  ['purchases', 'Achats et fournisseurs', 'Suivre les dépenses et les factures à payer.'],
  ['vat', 'TVA', 'Ranger la TVA dans les comptes prévus par vos réglages.'],
  ['payroll', 'Salaires et cotisations', 'Comptabiliser les salaires et les montants dus aux caisses.'],
];

export function AccountingSetupPanel({ settings, savedSettings, accounts, continuity, fields, busy, onChange, onReview, onStarter, onNewAccount }: {
  settings: AccountingSettings; savedSettings: AccountingSettings; accounts: Account[]; continuity: AccountingContinuity; fields: MappingField[]; busy: boolean;
  onChange: (settings: AccountingSettings) => void; onReview: () => void; onStarter: () => void; onNewAccount: () => void;
}) {
  const [open, setOpen] = useState<MappingGroup[]>(['sales']);
  const [showIssues, setShowIssues] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const issues = accountingMappingIssues(settings, accounts, fields);
  const required = fields.filter(field => field.required);
  const readinessIssues = accountingMappingIssues({ ...settings, enabled: true }, accounts, fields);
  const ready = required.filter(field => settings[field.key] && !readinessIssues.some(issue => issue.key === field.key)).length;
  const dirty = JSON.stringify(settings) !== JSON.stringify(savedSettings);
  function review() {
    if (busy) return;
    setShowIssues(true);
    const issue = issues[0];
    if (!issue) { onReview(); return; }
    const field = fields.find(field => field.key === issue.key)!;
    setOpen(current => current.includes(field.group) ? current : [...current, field.group]);
    requestAnimationFrame(() => {
      const input = panel.current?.querySelector<HTMLElement>(`[data-mapping-key="${issue.key}"]`);
      input?.focus({ preventScroll: true }); input?.closest('.field')?.scrollIntoView({ block: 'center' });
    });
  }
  return <section className="panel accounting-setup" ref={panel} aria-label="Configurer les écritures automatiques">
    <SectionHeading eyebrow="Réglages comptables" title="Comptes de liaison" description="Indiquez où ranger les factures et les paiements. Zentra préparera ensuite les écritures correspondantes." />
    {continuity.starterAvailable && <div className="accounting-setup__starter"><Landmark size={25} /><div><strong>Vous démarrez votre comptabilité ?</strong><p>La base essentielle prépare les comptes usuels et les relie aux opérations de l’application. Vous relirez ce qui sera activé avant de confirmer.</p><Button disabled={busy} onClick={onStarter}>Installer la base essentielle</Button><p className="accounting-setup__hint">Vous avez déjà un plan comptable ? Utilisez les réglages ci-dessous avec vos comptes.</p></div></div>}
    <label className="accounting-setup__enabled"><input type="checkbox" checked={settings.enabled} disabled={busy || (continuity.enabled && continuity.journalEntryCount > 0)} onChange={event => onChange({ ...settings, enabled: event.target.checked })} /><span><strong>Activer les écritures automatiques</strong><small>{continuity.enabled && continuity.journalEntryCount > 0 ? 'L’activation est conservée : des écritures existent déjà. Vous pouvez corriger les comptes pour les opérations futures.' : 'Ce choix sera appliqué lorsque vous aurez vérifié et enregistré les réglages.'}</small></span></label>
    <div className="accounting-setup__progress" role="status"><CheckCircle2 size={18} /><span>{ready} sur {required.length} comptes nécessaires renseignés{dirty ? ' · Modifications à enregistrer' : ''}</span></div>
    {!continuity.mappingRequirements && <p className="accounting-setup__hint">Les exigences détaillées du moteur ne sont pas disponibles. Le compte de TVA en attente est conservé dans les vérifications par précaution.</p>}
    <div className="accounting-setup__groups">{groups.filter(([group]) => fields.some(field => field.group === group)).map(([group, label, hint]) => {
      const members = fields.filter(field => field.group === group);
      const visible = open.includes(group);
      const groupIssues = issues.filter(issue => members.some(field => field.key === issue.key));
      return <section key={group} className="accounting-setup__group"><button type="button" className="accounting-setup__group-toggle" aria-expanded={visible} onClick={() => setOpen(current => visible ? current.filter(value => value !== group) : [...current, group])}><span><strong>{label}</strong><small>{hint}{showIssues && groupIssues.length > 0 ? ` ${groupIssues.length} point(s) à compléter.` : ''}</small></span><ChevronDown size={18} /></button><div hidden={!visible} className="accounting-setup__fields">{members.map(field => {
        const candidates = accounts.filter(account => account.active && account.accountType === field.type);
        const current = settings[field.key];
        const unavailable = current && !candidates.some(account => account.id === current);
        return <Field key={field.key} label={field.label} hint={field.hint} required={settings.enabled && field.required} error={showIssues ? issues.find(issue => issue.key === field.key)?.message : undefined}><select data-mapping-key={field.key} value={current} disabled={busy} onChange={event => onChange({ ...settings, [field.key]: event.target.value })}><option value="">{field.required ? 'Choisir un compte' : 'Aucun compte · facultatif'}</option>{unavailable && <option value={current} disabled>Compte actuel à remplacer</option>}{candidates.map(account => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}</select>{candidates.length === 0 && <span className="accounting-setup__hint">Aucun compte actif de ce type. Créez le compte manquant dans votre plan.</span>}</Field>;
      })}</div></section>;
    })}</div>
    <div className="accounting-setup__actions"><Button disabled={busy} onClick={review}>Vérifier avant d’enregistrer</Button><Button variant="secondary" disabled={busy} onClick={onNewAccount}>Créer un compte manquant</Button></div>
  </section>;
}
