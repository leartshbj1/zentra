import { useId, useState } from 'react';
import { Search } from 'lucide-react';
import { useAppLanguage } from './language';
import { autopilotCopy } from './autopilotPresentation';
import { COMMAND_EXAMPLES, commandHistory } from './autopilotCommand';

/**
 * "Demander à Autopilote": a sentence opens the matching form, prefilled.
 * Nothing is created from here; the person checks and saves in the form.
 */
export function AutopilotCommandBar({ onAsk, busy = false, notUnderstood = false }: {
  onAsk: (text: string) => void; busy?: boolean; notUnderstood?: boolean }) {
  const language = useAppLanguage(), copy = autopilotCopy(language);
  const [text, setText] = useState('');
  const listId = useId();
  const ask = (value: string) => { const sentence = value.trim(); if (!sentence || busy) return; onAsk(sentence); setText(''); };
  return <section className="autopilot-command" aria-label={copy.commandLabel}>
    <form onSubmit={event => { event.preventDefault(); ask(text); }}>
      <Search size={18} aria-hidden="true" />
      <input type="search" value={text} maxLength={500} list={listId} placeholder={copy.commandPlaceholder} aria-label={copy.commandLabel}
        disabled={busy} onChange={event => setText(event.target.value)} />
      <datalist id={listId}>{commandHistory().map(row => <option key={row} value={row} />)}</datalist>
      <button type="submit" disabled={busy || !text.trim()}>{copy.commandAsk}</button>
    </form>
    {notUnderstood ? <div className="autopilot-command__help" role="status">
      <p>{copy.commandNotUnderstood}</p>
      <ul>{(COMMAND_EXAMPLES[language as keyof typeof COMMAND_EXAMPLES] ?? COMMAND_EXAMPLES.fr).map(example => <li key={example}><button type="button" disabled={busy} onClick={() => ask(example)}>{example}</button></li>)}</ul>
    </div> : null}
  </section>;
}
