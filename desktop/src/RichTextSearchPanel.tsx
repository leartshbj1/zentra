import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { richPlainText, type RichText } from './documentComposition';
import type { TextSelection } from './richTextEditing';
import { findRichText, replaceRichTextMatches } from './richTextSearch';

export function RichTextSearchPanel({ value, initialQuery, disabled, maxLength, onSelect, onReplace, onClose }: {
  value: RichText; initialQuery: string; disabled: boolean; maxLength: number;
  onSelect: (selection: TextSelection) => void;
  onReplace: (value: RichText, selection: TextSelection) => boolean; onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery), [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false), [index, setIndex] = useState(0), [message, setMessage] = useState('');
  const locked = useRef(false);
  const matches = findRichText(value, query, caseSensitive);
  const current = Math.min(index, Math.max(0, matches.length - 1));
  const match = matches[current];
  const plain = richPlainText(value);
  function navigate(delta: number) {
    if (!matches.length) return;
    const next = (current + delta + matches.length) % matches.length;
    setIndex(next); onSelect(matches[next]);
  }
  function replace(all: boolean) {
    if (disabled || !match || locked.current) return;
    locked.current = true;
    try {
      const result = replaceRichTextMatches(value, all ? matches : [match], replacement, maxLength);
      if (result.error) { setMessage(result.error); return; }
      if (JSON.stringify(result.value) === JSON.stringify(value)) { setMessage('Le texte de remplacement est déjà identique.'); return; }
      const position = (all ? matches[0] : match).start + replacement.length;
      if (onReplace(result.value, { start: position, end: position })) {
        const remaining = findRichText(result.value, query, caseSensitive);
        const next = remaining.findIndex(range => range.start >= position);
        setIndex(next < 0 ? 0 : next);
        setMessage(`${result.count} remplacement${result.count > 1 ? 's' : ''} effectué${result.count > 1 ? 's' : ''}. Annuler permet de revenir en arrière.`);
      }
    } finally { locked.current = false; }
  }
  return <div className="rich-search" role="group" aria-label="Rechercher et remplacer dans cette zone" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  }}>
    <div className="rich-search__heading"><strong>Rechercher et remplacer</strong><button type="button" aria-label="Fermer la recherche" onClick={onClose}><X size={18} /></button></div>
    <p>Dans cette zone de texte uniquement. Le remplacement garde le style du premier caractère trouvé.</p>
    <label>Rechercher un texte<input autoFocus type="search" value={query} maxLength={maxLength} onChange={event => { setQuery(event.target.value); setIndex(0); setMessage(''); }} onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); navigate(event.shiftKey ? -1 : 1); }
    }} /></label>
    <label className="rich-search__choice"><input type="checkbox" checked={caseSensitive} onChange={event => { setCaseSensitive(event.target.checked); setIndex(0); setMessage(''); }} /> Respecter les majuscules et minuscules</label>
    <div className="rich-search__results"><span role="status">{!query ? 'Saisissez le texte à retrouver.' : matches.length ? `Résultat ${current + 1} sur ${matches.length}` : 'Aucun résultat dans cette zone.'}</span><button type="button" aria-label="Résultat précédent" disabled={!match} onClick={() => navigate(-1)}><ArrowUp size={17} /></button><button type="button" aria-label="Résultat suivant" disabled={!match} onClick={() => navigate(1)}><ArrowDown size={17} /></button></div>
    {match && <button type="button" className="rich-search__excerpt" aria-label="Sélectionner le résultat dans le texte" onClick={() => onSelect(match)}><span>{plain.slice(Math.max(0, match.start - 25), match.start)}</span><mark>{plain.slice(match.start, match.end)}</mark><span>{plain.slice(match.end, match.end + 35)}</span></button>}
    <label>Remplacer par<input value={replacement} maxLength={maxLength} disabled={disabled} onChange={event => { setReplacement(event.target.value); setMessage(''); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); replace(false); } }} /></label>
    <small>Laissez ce champ vide pour supprimer le texte trouvé.</small>
    <div className="rich-search__actions"><button type="button" disabled={disabled || !match} onClick={() => replace(false)}>Remplacer ce résultat</button><button type="button" disabled={disabled || !match} onClick={() => replace(true)}>Tout remplacer{matches.length ? ` (${matches.length})` : ''}</button></div>
    {message && <p role="status">{message}</p>}
  </div>;
}
