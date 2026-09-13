import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, Italic, Underline, List, ListOrdered, IndentIncrease, IndentDecrease, Undo2, Redo2, Highlighter, Baseline, RemoveFormatting, Search } from 'lucide-react';
import { normalizeRichText, richPlainText, richColor, richFont, richFontSize, documentFontCss, type RichRun, type RichText } from './documentComposition';
import { insertedTextRange, marksAtSelection, noTextMarks, paragraphStyleMarks, replaceRichSelection, richTextLimit, setParagraphStyle, setRichMarks, typographyAtSelection, type ParagraphStyle, type TextMarks } from './richTextEditing';
import { richTextFromClipboard } from './richTextClipboard';
import { RichTextSearchPanel } from './RichTextSearchPanel';
import { formatParagraphs, insertParagraphText, leaveEmptyList, paragraphFormatAt, paragraphMarkers, type ParagraphFormat } from './richParagraphEditing';
import { copyRichTextFormat } from './richTextEditing';

type Mark = 'bold' | 'italic' | 'underline';
type Bookmark = { start: number; end: number };
const textColors = [['#242424', 'Noir'], ['#134d33', 'Vert forêt'], ['#182b49', 'Bleu marine'], ['#793c32', 'Bordeaux'], ['#563d73', 'Prune'], ['#66523f', 'Brun']] as const;
const highlightColors = [['#fff0a6', 'Jaune'], ['#dcebd7', 'Vert clair'], ['#dceafc', 'Bleu clair'], ['#f8dddd', 'Rose'], ['#e8def5', 'Lavande'], ['#ededed', 'Gris clair']] as const;
export function formatRichSelection(value: RichText, selection: Bookmark, mark: Mark): RichText {
  if (selection.start === selection.end) return value;
  return setRichMarks(value, selection, { [mark]: !marksAtSelection(value, selection)[mark] });
}

function readEditor(root: HTMLElement, previous: RichText): RichText {
  // Browsers leave a native <br> when Select all / Delete empties the editor.
  // It is a caret placeholder, not an additional paragraph to save.
  if (!root.textContent) return normalizeRichText([{ ...previous[0], runs: [] }]);
  const paragraphs: RichText = [{ runs: [] }];
  let format: ParagraphFormat = { ...previous[0] };
  const append = (text: string, marks: Omit<RichRun, 'text'>) => {
    text.replace(/\r\n?/g, '\n').split('\n').forEach((part, i) => {
      if (i) paragraphs.push({ ...format, runs: [] });
      if (part) paragraphs.at(-1)!.runs.push({ text: part, ...marks });
    });
  };
  const walk = (node: Node, marks: Omit<RichRun, 'text'> = {}) => {
    if (node.nodeType === Node.TEXT_NODE) { append(node.textContent || '', marks); return; }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === 'BR') { if (node.dataset.placeholder !== 'true') append('\n', marks); return; }
    const next = { bold: marks.bold || /^(B|STRONG)$/.test(node.tagName) || node.dataset.bold === 'true', italic: marks.italic || /^(I|EM)$/.test(node.tagName) || node.dataset.italic === 'true', underline: marks.underline || node.tagName === 'U' || node.dataset.underline === 'true', color: richColor(node.dataset.color) || marks.color, highlight: richColor(node.dataset.highlight) || marks.highlight, fontFamily: richFont(node.dataset.fontFamily) || marks.fontFamily, fontSize: richFontSize(Number(node.dataset.fontSize)) || marks.fontSize };
    const isParagraph = (element: HTMLElement) => /^(DIV|P)$/.test(element.tagName) || element.classList.contains('rich-editor__paragraph');
    // Native editing can clone our block spans without the hidden separator.
    // Preserve that boundary, including an empty preceding paragraph.
    if (node !== root && isParagraph(node) && (paragraphs.at(-1)!.runs.length || node.previousSibling instanceof HTMLElement && isParagraph(node.previousSibling))) append('\n', marks);
    if (node.classList.contains('rich-editor__paragraph')) {
      format = { align: (node.style.textAlign || 'left') as ParagraphFormat['align'], bullet: node.dataset.bullet === 'true', numbered: node.dataset.numbered === 'true', indent: Number(node.dataset.indent || 0), spaceAfter: Number(node.dataset.spaceAfter || 0) };
      Object.assign(paragraphs.at(-1)!, format);
    }
    node.childNodes.forEach(child => walk(child, next));
  };
  root.childNodes.forEach(child => walk(child));
  return normalizeRichText(paragraphs);
}
function bookmark(root: HTMLElement): Bookmark | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  const range = selection.getRangeAt(0), prefix = range.cloneRange();
  prefix.selectNodeContents(root); prefix.setEnd(range.startContainer, range.startOffset);
  return { start: prefix.toString().length, end: prefix.toString().length + range.toString().length };
}
function restore(root: HTMLElement, saved: Bookmark) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = []; while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  if (!nodes.length) root.appendChild(document.createTextNode(''));
  if (!nodes.length) nodes.push(root.firstChild as Text);
  const point = (target: number): [Node, number] => {
    for (const node of nodes) { if (node.parentElement?.dataset.separator === 'true') { target -= node.length; continue; } if (target <= node.length) return [node, Math.max(0, target)]; target -= node.length; }
    return [nodes.at(-1)!, nodes.at(-1)!.length];
  };
  const range = document.createRange(); range.setStart(...point(saved.start)); range.setEnd(...point(saved.end));
  const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
}
export function selectRichTextRange(root: HTMLElement, range: Bookmark) {
  root.focus({ preventScroll: true });
  restore(root, range);
}
function paint(root: HTMLElement, value: RichText) {
  root.replaceChildren();
  const markers = paragraphMarkers(value);
  value.forEach((p, i) => {
    if (i) { const separator = document.createElement('span'); separator.style.display = 'none'; separator.dataset.separator = 'true'; separator.textContent = '\n'; root.appendChild(separator); }
    const paragraph = document.createElement('span'); paragraph.className = 'rich-editor__paragraph'; paragraph.style.textAlign = p.align || 'left'; paragraph.dataset.bullet = String(!!p.bullet);
    paragraph.dataset.numbered = String(!!p.numbered); paragraph.dataset.marker = markers[i];
    paragraph.dataset.indent = String(p.indent ?? 0); paragraph.dataset.spaceAfter = String(p.spaceAfter ?? 0);
    paragraph.style.marginLeft = `${(p.indent ?? 0) * 1.5}em`;
    paragraph.style.marginBottom = `calc(${p.spaceAfter ?? 0} * var(--rich-editor-point, 1px))`;
    p.runs.forEach(run => {
      const span = document.createElement('span'); span.textContent = run.text;
      for (const key of ['bold', 'italic', 'underline'] as const) span.dataset[key] = String(!!run[key]);
      span.style.fontWeight = run.bold ? '700' : '400'; span.style.fontStyle = run.italic ? 'italic' : 'normal'; span.style.textDecoration = run.underline ? 'underline' : 'none';
      if (run.color) { span.dataset.color = run.color; span.style.color = run.color; }
      if (run.highlight) { span.dataset.highlight = run.highlight; span.style.backgroundColor = run.highlight; }
      if (run.fontFamily) { span.dataset.fontFamily = run.fontFamily; span.style.fontFamily = documentFontCss[run.fontFamily]; }
      if (run.fontSize) { span.dataset.fontSize = String(run.fontSize); span.style.fontSize = `calc(${run.fontSize} * var(--rich-editor-point, 1px))`; }
      paragraph.appendChild(span);
    }); if (!paragraph.childNodes.length) { paragraph.appendChild(document.createTextNode('')); const placeholder = document.createElement('br'); placeholder.dataset.placeholder = 'true'; paragraph.appendChild(placeholder); } root.appendChild(paragraph);
  });
}

export function RichTextEditor({ label, value, onChange, disabled = false, maxLength = 5000, fontFamily, baseFontSize = 9 }: { label: string; value: RichText; onChange: (value: RichText) => void; disabled?: boolean; maxLength?: number; fontFamily?: string; baseFontSize?: number }) {
  const root = useRef<HTMLDivElement>(null), saved = useRef<Bookmark>({ start: 0, end: 0 });
  const current = useRef(value), composing = useRef(false);
  const history = useRef<RichText[]>([]), future = useRef<RichText[]>([]);
  const [revision, setRevision] = useState(0), [message, setMessage] = useState('');
  const pendingMarks = useRef<{ position: number; marks: TextMarks } | null>(null);
  const [activeMarks, setActiveMarks] = useState<TextMarks>(noTextMarks);
  const [typography, setTypography] = useState<ReturnType<typeof typographyAtSelection>>({ fontFamily: '', fontSize: '' });
  const [paragraphFormat, setParagraphFormat] = useState(() => paragraphFormatAt(value, { start: 0, end: 0 }));
  const [copiedFormat, setCopiedFormat] = useState<TextMarks | null>(null);
  const [colorTool, setColorTool] = useState<'color' | 'highlight' | null>(null);
  const [keepPasteStyle, setKeepPasteStyle] = useState(true);
  const [search, setSearch] = useState<{ query: string; id: number } | null>(null);
  const searchSession = useRef(0);
  function showMarks(marks: TextMarks) {
    setActiveMarks(old => old.bold === marks.bold && old.italic === marks.italic && old.underline === marks.underline && old.color === marks.color && old.highlight === marks.highlight && old.fontFamily === marks.fontFamily && old.fontSize === marks.fontSize ? old : marks);
    const next = pendingMarks.current ? { fontFamily: marks.fontFamily || '', fontSize: marks.fontSize || '' } : typographyAtSelection(current.current, saved.current);
    setTypography(old => old.fontFamily === next.fontFamily && old.fontSize === next.fontSize ? old : next);
  }
  useLayoutEffect(() => {
    const el = root.current; if (!el || composing.current) return;
    if (JSON.stringify(value) !== JSON.stringify(current.current)) {
      // An outer undo, copied presentation or refreshed settings replaces the zone.
      // Discard local redo entries from the old text instead of resurrecting them.
      history.current = []; future.current = []; pendingMarks.current = null;
      const length = richPlainText(value).length;
      saved.current = { start: Math.min(saved.current.start, length), end: Math.min(saved.current.end, length) };
      setMessage(''); setRevision(r => r + 1);
    }
    const focused = document.activeElement === el;
    paint(el, value); if (focused) restore(el, saved.current);
    current.current = value;
    showMarks(pendingMarks.current?.marks || marksAtSelection(value, saved.current));
    setParagraphFormat(paragraphFormatAt(value, saved.current));
  }, [value, revision]);
  useEffect(() => {
    const listener = () => {
      const selection = root.current && bookmark(root.current); if (!selection) return;
      saved.current = selection;
      if (pendingMarks.current && (selection.start !== selection.end || selection.start !== pendingMarks.current.position)) pendingMarks.current = null;
      showMarks(pendingMarks.current?.marks || marksAtSelection(current.current, selection));
      setParagraphFormat(paragraphFormatAt(current.current, selection));
    };
    document.addEventListener('selectionchange', listener); return () => document.removeEventListener('selectionchange', listener);
  }, []);
  function commit(next: RichText, remember = true) {
    if (disabled) return false;
    next = normalizeRichText(next);
    const limit = richTextLimit(next, maxLength);
    if (limit) { setMessage(limit); paint(root.current!, current.current); restore(root.current!, saved.current); return false; }
    if (remember) { history.current.push(current.current); if (history.current.length > 60) history.current.shift(); future.current = []; }
    current.current = next; setMessage(''); onChange(next); setRevision(r => r + 1);
    return true;
  }
  function input() {
    if (composing.current || !root.current) return;
    saved.current = bookmark(root.current) || saved.current;
    let next = readEditor(root.current, current.current);
    const range = insertedTextRange(richPlainText(current.current), richPlainText(next));
    if (pendingMarks.current) {
      if (range.start === pendingMarks.current.position && range.end > range.start) {
        next = setRichMarks(next, range, pendingMarks.current.marks);
        pendingMarks.current.position = saved.current.end;
      } else pendingMarks.current = null;
    }
    commit(next);
  }
  function insert(text: string) {
    if (disabled) return;
    saved.current = bookmark(root.current!) || saved.current;
    const before = saved.current;
    const next = insertParagraphText(current.current, before, text, pendingMarks.current?.marks);
    const position = before.start + text.replace(/\r\n?/g, '\n').length;
    saved.current = { start: position, end: position };
    if (commit(next)) {
      if (pendingMarks.current) pendingMarks.current.position = position;
      root.current?.focus();
    } else saved.current = before;
  }
  function enter() {
    if (disabled) return;
    saved.current = bookmark(root.current!) || saved.current;
    const next = leaveEmptyList(current.current, saved.current);
    if (next) { commit(next); root.current?.focus(); }
    else insert('\n');
  }
  function mark(key: Mark) {
    saved.current = bookmark(root.current!) || saved.current;
    const marks = pendingMarks.current?.marks || marksAtSelection(current.current, saved.current);
    applyMarks({ [key]: !marks[key] });
  }
  function applyMarks(patch: Partial<TextMarks>) {
    if (disabled) return;
    saved.current = bookmark(root.current!) || saved.current;
    if (saved.current.start === saved.current.end) {
      const marks = pendingMarks.current?.marks || marksAtSelection(current.current, saved.current);
      const next = { ...marks, ...patch };
      pendingMarks.current = { position: saved.current.start, marks: next }; showMarks(next); setMessage('');
      root.current?.focus(); restore(root.current!, saved.current); return;
    }
    pendingMarks.current = null;
    const next = setRichMarks(current.current, saved.current, patch);
    commit(next); showMarks(marksAtSelection(next, saved.current)); root.current?.focus();
  }
  function paragraph(change: ParagraphFormat | 'indent' | 'outdent') {
    if (disabled) return;
    saved.current = bookmark(root.current!) || saved.current;
    const format = paragraphFormatAt(current.current, saved.current);
    const patch = typeof change === 'string' ? change : change.numbered !== undefined ? { numbered: !format.numbered, bullet: false }
      : change.bullet !== undefined ? { bullet: !format.bullet, numbered: false } : change;
    const next = formatParagraphs(current.current, saved.current, patch);
    commit(next); setParagraphFormat(paragraphFormatAt(next, saved.current)); root.current?.focus();
  }
  function paragraphStyle(style: ParagraphStyle) {
    if (disabled) return;
    saved.current = bookmark(root.current!) || saved.current;
    const next = setParagraphStyle(current.current, saved.current, style);
    if (commit(next)) {
      if (saved.current.start === saved.current.end) pendingMarks.current = { position: saved.current.start, marks: { ...marksAtSelection(next, saved.current), ...paragraphStyleMarks[style] } };
      showMarks(pendingMarks.current?.marks || marksAtSelection(next, saved.current));
      root.current?.focus();
    }
  }
  function paste(html: string, plain: string) {
    if (disabled) return;
    const rich = keepPasteStyle ? richTextFromClipboard(html) : null;
    if (!rich) { insert(plain); return; }
    saved.current = bookmark(root.current!) || saved.current;
    const previous = saved.current;
    const next = replaceRichSelection(current.current, previous, rich);
    if (richTextLimit(next, maxLength)) { commit(next); return; }
    pendingMarks.current = null;
    const position = previous.start + richPlainText(rich).length;
    saved.current = { start: position, end: position };
    if (commit(next)) {
      showMarks(marksAtSelection(next, saved.current));
      setMessage('Texte collé avec sa mise en forme. Les polices sont adaptées aux trois polices du document.');
    } else saved.current = previous;
  }
  function undo(redo = false) { if (disabled) return; pendingMarks.current = null; const from = redo ? future.current : history.current, to = redo ? history.current : future.current; const next = from.pop(); if (next) { to.push(current.current); const length = richPlainText(next).length; saved.current = { start: Math.min(saved.current.start, length), end: Math.min(saved.current.end, length) }; commit(next, false); root.current?.focus(); } }
  function openSearch() {
    saved.current = bookmark(root.current!) || saved.current;
    const selected = richPlainText(current.current).slice(saved.current.start, saved.current.end);
    setSearch({ query: selected.length <= 120 && !selected.includes('\n') ? selected : '', id: ++searchSession.current });
    setColorTool(null);
  }
  function selectMatch(selection: Bookmark) {
    saved.current = selection; pendingMarks.current = null;
    root.current?.focus(); restore(root.current!, selection);
    const node = window.getSelection()?.anchorNode;
    (node instanceof HTMLElement ? node : node?.parentElement)?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
  return <div className="rich-editor">
    <div className="rich-editor__label">{label}</div>
    <div className="rich-format-copy" role="group" aria-label="Reproduire la mise en forme" onMouseDown={e => { if ((e.target as HTMLElement).closest('button')) e.preventDefault(); }}>
      <button type="button" disabled={disabled || !richPlainText(value).length} onClick={() => {
        saved.current = bookmark(root.current!) || saved.current;
        setCopiedFormat(copyRichTextFormat(current.current, saved.current));
        setMessage('Style copié. Sélectionnez un autre passage dans ce texte, puis choisissez Appliquer le style. Si la sélection mélange plusieurs styles, celui du premier caractère est repris.');
      }}>Copier le style</button>
      <button type="button" disabled={disabled || !copiedFormat} onClick={() => {
        if (!copiedFormat) return;
        applyMarks(copiedFormat);
        setMessage(saved.current.start === saved.current.end ? 'Le style copié est prêt pour la suite de votre saisie.' : 'Style appliqué. Annuler permet de retrouver la mise en forme précédente.');
      }}>Appliquer le style</button>
    </div>
    <button type="button" className="rich-editor__search-toggle" aria-expanded={!!search} onClick={() => search ? setSearch(null) : openSearch()}><Search size={17} /> Rechercher et remplacer</button>
    {search && <RichTextSearchPanel key={search.id} value={value} initialQuery={search.query} disabled={disabled} maxLength={maxLength} onSelect={selectMatch} onClose={() => { setSearch(null); selectMatch(saved.current); }} onReplace={(next, selection) => {
      if (disabled) return false;
      pendingMarks.current = null; saved.current = selection;
      return commit(next);
    }} />}
    <div className="rich-editor__styles" role="group" aria-label={`Styles de paragraphe : ${label}`} onMouseDown={event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault(); }}>
      <span>Style du paragraphe</span>
      {([['normal', 'Texte normal'], ['heading', 'Titre de section'], ['subheading', 'Sous-titre']] as const).map(([style, title]) => <button type="button" key={style} disabled={disabled} className={`rich-editor__style--${style}`} onClick={() => paragraphStyle(style)}>{title}</button>)}
    </div>
    <div className="rich-editor__typography" role="group" aria-label={`Police et taille : ${label}`}>
      <label>Police du passage<select aria-label="Police du passage" value={typography.fontFamily} disabled={disabled} onChange={event => applyMarks({ fontFamily: richFont(event.target.value) })}><option value="">Du document</option>{typography.fontFamily === 'mixed' && <option value="mixed" disabled>Mixte</option>}<option value="helvetica">Helvetica</option><option value="times">Times</option><option value="courier">Courier</option></select></label>
      <label>Taille du passage<select aria-label="Taille du passage" value={typography.fontSize} disabled={disabled} onChange={event => applyMarks({ fontSize: richFontSize(Number(event.target.value)) })}><option value="">Du document</option>{typography.fontSize === 'mixed' && <option value="mixed" disabled>Mixte</option>}{[8,9,10,11,12,14,16,18,20,24].map(size => <option key={size} value={size}>{size} pt</option>)}{activeMarks.fontSize && ![8,9,10,11,12,14,16,18,20,24].includes(activeMarks.fontSize) && <option value={activeMarks.fontSize}>{activeMarks.fontSize} pt</option>}</select></label>
    </div>
    <details className="rich-editor__paragraph-options"><summary>Espacement des paragraphes</summary>
      <label>Espace après le paragraphe<select aria-label="Espace après le paragraphe" disabled={disabled} value={paragraphFormat.spaceAfter} onChange={event => paragraph({ spaceAfter: Number(event.target.value) })}>
        {paragraphFormat.spaceAfter === 'mixed' && <option value="mixed" disabled>Différents espacements</option>}
        {[[0, 'Aucun'], [3, 'Discret · 3 pt'], [6, 'Équilibré · 6 pt'], [12, 'Aéré · 12 pt'], [18, 'Très aéré · 18 pt']].map(([value, title]) => <option key={value} value={value}>{title}</option>)}
        {typeof paragraphFormat.spaceAfter === 'number' && ![0,3,6,12,18].includes(paragraphFormat.spaceAfter) && <option value={paragraphFormat.spaceAfter}>{paragraphFormat.spaceAfter} pt</option>}
      </select></label><small>S’applique au paragraphe courant ou à ceux que vous avez sélectionnés.</small>
    </details>
    <div className="rich-editor__toolbar" role="group" aria-label={`Mise en forme : ${label}`} onMouseDown={e => e.preventDefault()}>
      {([['bold', Bold, 'Gras'], ['italic', Italic, 'Italique'], ['underline', Underline, 'Souligner']] as const).map(([key, Icon, title]) => <button key={key} type="button" title={title} aria-label={title} aria-pressed={activeMarks[key]} disabled={disabled} onClick={() => mark(key)}><Icon size={17} /></button>)}
      {([['left', AlignLeft, 'Aligner à gauche'], ['center', AlignCenter, 'Centrer'], ['right', AlignRight, 'Aligner à droite']] as const).map(([align, Icon, title]) => <button key={align} type="button" title={title} aria-label={title} disabled={disabled} onClick={() => paragraph({ align })}><Icon size={17} /></button>)}
      <button type="button" aria-label="Liste à puces" title="Liste à puces" aria-pressed={paragraphFormat.bullet} disabled={disabled} onClick={() => paragraph({ bullet: true })}><List size={17} /></button>
      <button type="button" aria-label="Liste numérotée" title="Liste numérotée" aria-pressed={paragraphFormat.numbered} disabled={disabled} onClick={() => paragraph({ numbered: true })}><ListOrdered size={17} /></button>
      <button type="button" aria-label="Diminuer le retrait" title="Diminuer le retrait" disabled={disabled || !paragraphFormat.canOutdent} onClick={() => paragraph('outdent')}><IndentDecrease size={17} /></button>
      <button type="button" aria-label="Augmenter le retrait" title="Augmenter le retrait" disabled={disabled || !paragraphFormat.canIndent} onClick={() => paragraph('indent')}><IndentIncrease size={17} /></button>
      <button type="button" aria-label="Couleur du texte" title="Couleur du texte" aria-expanded={colorTool === 'color'} disabled={disabled} onClick={() => setColorTool(colorTool === 'color' ? null : 'color')}><Baseline size={17} style={{ color: activeMarks.color }} /></button>
      <button type="button" aria-label="Surligner le texte" title="Surligner le texte" aria-expanded={colorTool === 'highlight'} disabled={disabled} onClick={() => setColorTool(colorTool === 'highlight' ? null : 'highlight')}><Highlighter size={17} /></button>
      <button type="button" aria-label="Effacer la mise en forme" title="Effacer la mise en forme des mots sélectionnés" disabled={disabled} onClick={() => applyMarks({ ...noTextMarks, color: undefined, highlight: undefined, fontFamily: undefined, fontSize: undefined })}><RemoveFormatting size={17} /></button>
      <button type="button" aria-label="Annuler la modification du texte" title="Annuler" disabled={disabled || !history.current.length} onClick={() => undo()}><Undo2 size={17} /></button>
      <button type="button" aria-label="Rétablir la modification du texte" title="Rétablir" disabled={disabled || !future.current.length} onClick={() => undo(true)}><Redo2 size={17} /></button>
    </div>
    {colorTool && <div className="rich-editor__colors" role="group" aria-label={colorTool === 'color' ? 'Choisir la couleur du texte' : 'Choisir le surlignage'} onMouseDown={e => { if ((e.target as HTMLElement).closest('button')) e.preventDefault(); }}>
      <span>{colorTool === 'color' ? 'Couleur des mots sélectionnés' : 'Surlignage des mots sélectionnés'}</span>
      <div className="rich-editor__swatches">{(colorTool === 'color' ? textColors : highlightColors).map(([color, name]) => <button type="button" key={color} aria-label={name} title={name} aria-pressed={activeMarks[colorTool] === color} disabled={disabled} style={{ backgroundColor: color }} onClick={() => applyMarks({ [colorTool]: color })} />)}</div>
      <label>Couleur personnalisée<input type="color" aria-label={colorTool === 'color' ? 'Couleur de texte personnalisée' : 'Couleur de surlignage personnalisée'} value={activeMarks[colorTool] || (colorTool === 'color' ? '#242424' : '#fff0a6')} disabled={disabled} onChange={e => applyMarks({ [colorTool]: e.target.value })} /></label>
      <button type="button" disabled={disabled} onClick={() => applyMarks({ [colorTool]: undefined })}>{colorTool === 'color' ? 'Couleur automatique' : 'Sans surlignage'}</button>
      <button type="button" onClick={() => { setColorTool(null); root.current?.focus(); restore(root.current!, saved.current); }}>Fermer les couleurs</button>
    </div>}
    <div ref={root} className="rich-editor__surface" style={{ fontFamily, '--rich-editor-point': `${15 / baseFontSize}px` } as CSSProperties} contentEditable={!disabled} suppressContentEditableWarning role="textbox" aria-label={label} aria-multiline="true" aria-disabled={disabled} spellCheck onInput={input}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; input(); }}
      onBeforeInput={event => { const type = (event.nativeEvent as InputEvent).inputType; if (['insertParagraph', 'insertLineBreak'].includes(type)) { event.preventDefault(); enter(); } else if (type === 'historyUndo' || type === 'historyRedo') { event.preventDefault(); undo(type === 'historyRedo'); } }}
      onPaste={event => { event.preventDefault(); paste(event.clipboardData.getData('text/html'), event.clipboardData.getData('text/plain')); }} onDrop={event => event.preventDefault()}
      onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); if (!disabled) enter(); } if (event.ctrlKey || event.metaKey) { const key = event.key.toLowerCase(); if (key === 'f') { event.preventDefault(); openSearch(); } if (['b','i','u','z','y'].includes(key)) { event.preventDefault(); if (key === 'z' || key === 'y') undo(key === 'y' || event.shiftKey); else mark(({ b:'bold', i:'italic', u:'underline' } as const)[key as 'b'|'i'|'u']); } } }} />
    <small>Sélectionnez des mots, ou activez un style avant d’écrire. Entrée ajoute un paragraphe et continue les listes ; une deuxième Entrée termine une liste. {richPlainText(value).length}/{maxLength}</small>
    <label className="rich-editor__paste-choice"><input type="checkbox" checked={keepPasteStyle} disabled={disabled} onChange={event => setKeepPasteStyle(event.target.checked)} /> Conserver la mise en forme du texte collé</label>
    {message && <p role="status">{message}</p>}
  </div>;
}
