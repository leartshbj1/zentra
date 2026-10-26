import { useEffect, useMemo, useRef, useState } from 'react';
import { localDate } from './cashBook';
import { dictationDraft, type DictationDraft } from './dictation';
import { getAppLanguage, t, useAppLanguage } from './language';
import { appendSpoken, speechAvailable, startSpeech } from './speechInput';
import type { Workspace } from './types';
import { Button, Field, Modal } from './ui';
import { formatMoney } from './utils';
import './terrain.css';

export type DictationTarget = 'report' | 'quote';
export type DictationResult = DictationDraft & { target: DictationTarget; clientId: string | null; reportDate: string };

let lineCounter = 0;
const lineId = () => `dictation-${Date.now().toString(36)}-${++lineCounter}`;

/**
 * Dictée sur le téléphone : le texte reste modifiable, puis Zentra prépare un
 * brouillon de rapport ou de devis. Les prix viennent du catalogue ; rien
 * n'est enregistré avant le clic.
 */
export function DictationDialog({ workspace, initialTarget, busy, onClose, onCreate }: { workspace: Workspace; initialTarget: DictationTarget; busy: boolean; onClose: () => void; onCreate: (result: DictationResult) => void }) {
  useAppLanguage();
  const [target, setTarget] = useState<DictationTarget>(initialTarget);
  const [text, setText] = useState('');
  const [interim, setInterim] = useState('');
  const [listening, setListening] = useState(false);
  const [speechError, setSpeechError] = useState(false);
  const [clientId, setClientId] = useState<string | null>(null);
  const stop = useRef<() => void>(() => {});
  const canListen = speechAvailable();
  const vatRegistered = workspace.settings?.organization.vatRegistered ?? false;
  const draft = useMemo(() => dictationDraft(text, workspace.clients, workspace.catalogItems, vatRegistered, lineId), [text, workspace.clients, workspace.catalogItems, vatRegistered]);
  const chosenClient = clientId ?? draft.clientId;
  const clients = workspace.clients.filter(client => !client.archivedAt);
  useEffect(() => () => stop.current(), []);

  function listen() {
    if (listening) { stop.current(); return; }
    setSpeechError(false);
    setListening(true);
    stop.current = startSpeech(getAppLanguage(), spoken => setText(current => appendSpoken(current, spoken)), setInterim, error => {
      setListening(false);
      setInterim('');
      if (error && error !== 'aborted' && error !== 'no-speech') setSpeechError(true);
    });
  }

  const ready = text.trim().length > 0 && (target === 'quote' || Boolean(chosenClient));
  return <Modal title={t('Dicter un brouillon')} description={t('Parlez, relisez le texte, puis Zentra prépare le brouillon. Les prix viennent de votre catalogue.')} onClose={() => { stop.current(); onClose(); }}>
    <div className="erp-register dictation">
      <div className="planning-switch" role="group" aria-label={t('Brouillon à préparer')}>
        <button type="button" aria-pressed={target === 'report'} onClick={() => setTarget('report')}>{t('Rapport d’intervention')}</button>
        <button type="button" aria-pressed={target === 'quote'} onClick={() => setTarget('quote')}>{t('Devis')}</button>
      </div>
      <Field label={t('Ce que vous dites')} hint={canListen ? undefined : t('Touchez le micro du clavier de votre téléphone pour dicter.')}>
        <textarea value={text} rows={6} maxLength={4000} placeholder={t('Par exemple : chez Keller, remplacement de la vanne thermostatique, une heure et demie de travail, trois coudes de 22.')}
          onChange={event => setText(event.target.value)} />
      </Field>
      {listening ? <p className="dictation__listening" role="status">{t('J’écoute…')}{interim ? ` ${interim}` : ''}</p> : null}
      {speechError ? <p role="status">{t('La reconnaissance vocale n’est pas disponible ici. Touchez le micro du clavier pour dicter.')}</p> : null}
      <div className="erp-register__actions">
        {canListen ? <Button variant="secondary" onClick={listen}>{listening ? t('Arrêter la dictée') : t('Dicter')}</Button> : null}
        {text ? <Button variant="ghost" onClick={() => { setText(''); setClientId(null); }}>{t('Effacer')}</Button> : null}
      </div>
      {text.trim() ? <section aria-labelledby="dictation-draft-title">
        <h3 id="dictation-draft-title">{target === 'report' ? t('Brouillon du rapport') : t('Brouillon du devis')}</h3>
        <Field label={t('Client')} hint={draft.partyName && !chosenClient ? t('« {name} » n’est pas dans vos clients.', { name: draft.partyName }) : undefined}>
          <select value={chosenClient ?? ''} onChange={event => setClientId(event.target.value || null)}>
            <option value="">{t('Choisir un client')}</option>
            {clients.map(client => <option key={client.id} value={client.id}>{client.company || client.name}</option>)}
          </select>
        </Field>
        {draft.description ? <p>{draft.description}</p> : null}
        {draft.lines.length ? <ul className="dictation__lines">
          {draft.lines.map(line => <li key={line.id}>
            <span>{line.description}<small>{` · ${line.quantity} ${line.unit}`}</small></span>
            <span>{line.catalogItemId ? formatMoney(Math.round(line.quantity * line.unitPriceCents)) : <small>{t('Prix à compléter')}</small>}</span>
          </li>)}
        </ul> : <p>{t('Aucune heure ni quantité reconnue : le texte sera repris tel quel.')}</p>}
        {draft.missing.length ? <p>{t('Pas trouvé dans le catalogue : {items}. Ces lignes restent à compléter.', { items: draft.missing.join(', ') })}</p> : null}
      </section> : null}
      <div className="erp-register__actions">
        <Button disabled={busy || !ready} onClick={() => { stop.current(); onCreate({ ...draft, target, clientId: chosenClient, reportDate: localDate(new Date()) }); }}>
          {target === 'report' ? t('Créer le rapport en brouillon') : t('Ouvrir le devis')}
        </Button>
        <Button variant="ghost" onClick={() => { stop.current(); onClose(); }}>{t('Annuler')}</Button>
      </div>
    </div>
  </Modal>;
}
