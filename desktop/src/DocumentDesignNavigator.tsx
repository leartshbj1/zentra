import { useId, useRef, useState } from 'react';
import { ArrowUpRight, Search, X } from 'lucide-react';
import type { DocumentDesignKind } from './documentAppearance';
import { findDocumentDesignTools, type DocumentDesignTool } from './documentDesignTools';

export function DocumentDesignNavigator({ kind, onChoose }: { kind: DocumentDesignKind; onChoose: (tool: DocumentDesignTool) => void }) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const results = findDocumentDesignTools(query, kind);
  function clear() { setQuery(''); input.current?.focus(); }
  return <div className="design-navigator" onKeyDown={event => {
    if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); clear(); }
  }}>
    <label htmlFor={id}>Trouvez votre outil</label>
    <div className="design-navigator__input"><Search size={18} aria-hidden="true" />
      <input ref={input} id={id} type="search" maxLength={80} value={query} placeholder="Police, logo, gras, marges…" aria-controls={`${id}-results`} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); if (results.length === 1) { onChoose(results[0]); setQuery(''); } else document.getElementById(`${id}-results`)?.querySelector('button')?.focus(); }
        if (event.key === 'ArrowDown' && results.length) { event.preventDefault(); document.getElementById(`${id}-results`)?.querySelector('button')?.focus(); }
      }} />
      {query && <button type="button" aria-label="Effacer la recherche d’outil" onClick={clear}><X size={18} /></button>}
    </div>
    <div id={`${id}-results`} className="design-navigator__results">
      {query.trim() && <><p role="status">{results.length ? `${results.length} outil${results.length > 1 ? 's' : ''} disponible${results.length > 1 ? 's' : ''}` : 'Aucun outil trouvé. Essayez « logo », « police » ou « texte ».'}</p>
        {results.map(tool => <button type="button" key={tool.id} onClick={() => { onChoose(tool); setQuery(''); }}><span><strong>{tool.label}</strong><small>{tool.description}</small></span><ArrowUpRight size={18} aria-hidden="true" /></button>)}
      </>}
    </div>
  </div>;
}
