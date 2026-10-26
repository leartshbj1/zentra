import { AUTOPILOT_KIND_LABELS } from './autopilotKinds';
import { autopilotCopy } from './autopilotPresentation';
import { AUTO_VALIDATION_CASES, type AutopilotBehaviour } from './autopilotSettings';
import { t, useAppLanguage } from './language';

/**
 * How Autopilote behaves for this company on this device: the domains where only
 * sure cards show, and the exact cases it may validate alone (off by default).
 * Pausing lives in the team choice above (Prépare / Observe / En pause), once.
 */
export function AutopilotBehaviourSettings({ behaviour, onChange, disabled = false }: { behaviour: AutopilotBehaviour;
  onChange: (change: Partial<AutopilotBehaviour>) => void; disabled?: boolean }) {
  const copy = autopilotCopy(useAppLanguage());
  const toggle = <T extends string>(list: readonly T[], value: T, on: boolean) => on ? [...new Set([...list, value])] : list.filter(item => item !== value);
  return <section className="quote-autopilot quote-autopilot--settings quote-autopilot--behaviour" aria-labelledby="autopilot-behaviour-title">
    <header><div><h2 id="autopilot-behaviour-title">{copy.behaviourTitle}</h2><p>{copy.behaviourDetail}</p></div></header>
    <fieldset className="quote-autopilot__behaviour-group" disabled={disabled || behaviour.paused}>
      <legend>{copy.onlySureTitle}</legend>
      <p className="quote-autopilot__context">{copy.onlySureDetail}</p>
      {AUTOPILOT_KIND_LABELS.map(kind => <label key={kind} className="quote-autopilot__consent">
        <input type="checkbox" checked={behaviour.onlySure.includes(kind)} onChange={event => onChange({ onlySure: toggle(behaviour.onlySure, kind, event.target.checked) })} />
        <span><strong>{t(kind)}</strong></span>
      </label>)}
    </fieldset>
    <fieldset className="quote-autopilot__behaviour-group" disabled={disabled || behaviour.paused}>
      <legend>{copy.autoTitle}</legend>
      <p className="quote-autopilot__context">{copy.autoDetail}</p>
      {AUTO_VALIDATION_CASES.map(item => <label key={item} className="quote-autopilot__consent">
        <input type="checkbox" checked={behaviour.autoValidate.includes(item)} onChange={event => onChange({ autoValidate: toggle(behaviour.autoValidate, item, event.target.checked) })} />
        <span><strong>{item === 'qrmail' ? copy.autoQrMail : copy.autoContact}</strong><small>{item === 'qrmail' ? copy.autoQrMailDetail : copy.autoContactDetail}</small></span>
      </label>)}
    </fieldset>
  </section>;
}
