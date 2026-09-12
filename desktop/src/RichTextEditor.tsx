import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, Italic, Underline, List, Undo2, Redo2 } from 'lucide-react';
import { normalizeRichText, richPlainText, type RichRun, type RichText } from './documentComposition';
import { insertedTextRange, marksAtSelection, noTextMarks, richTextLimit, selectedParagraphs, setRichMarks, type TextMarks } from './richTextEditing';

type Mark = 'bold' | 'italic' | 'underline';
type Bookmark = { start: number; end: number };
export function formatRichSelection(value: RichText, selection: Bookmark, mark: Mark): RichText {
  if (selection.start === selection.end) return value;
  return setRichMarks(value, selection, { [mark]: !marksAtSelection(value, selection)[mark] });
}

function readEditor(root: HTMLElement, previous: RichText): RichText {
  const paragraphs: RichText = [{ runs: [] }];
  const append = (text: string, marks: Omit<RichRun, 'text'>) => {
    text.replace(/\r\n?/g, '\n').split('\n').forEach((part, i) => {
      if (i) paragraphs.push({ runs: [] });
      if (part) paragraphs.at(-1)!.runs.push({ text: part, ...marks });
    });
  };
  const walk = (node: Node, marks: Omit<RichRun, 'text'> = {}) => {
    if (node.nodeType === Node.TEXT_NODE) { append(node.textContent || '', marks); return; }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === 'BR') { if (node.dataset.placeholder !== 'true') append('\n', marks); return; }
    const next = { bold: marks.bold || /^(B|STRONG)$/.test(node.tagName) || node.dataset.bold === 'true', italic: marks.italic || /^(I|EM)$/.test(node.tagName) || node.dataset.italic === 'true', underline: marks.underline || node.tagName === 'U' || node.dataset.underline === 'true' };
    const isParagraph = (element: HTMLElement) => /^(DIV|P)$/.test(element.tagName) || element.classList.contains('rich-editor__paragraph');
    // Native editing can clone our block spans without the hidden separator.
    // Preserve that boundary, including an empty preceding paragraph.
    if (node !== root && isParagraph(node) && (paragraphs.at(-1)!.runs.length || node.previousSibling instanceof HTMLElement && isParagraph(node.previousSibling))) append('\n', marks);
    node.childNodes.forEach(child => walk(child, next));
  };
  root.childNodes.forEach(child => walk(child));
  return normalizeRichText(paragraphs.map((p, i) => ({ ...p, align: previous[i]?.align || 'left', bullet: previous[i]?.bullet || false })));
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
function paint(root: HTMLElement, value: RichText) {
  root.replaceChildren();
  value.forEach((p, i) => {
    if (i) { const separator = document.createElement('span'); separator.style.display = 'none'; separator.dataset.separator = 'true'; separator.textContent = '\n'; root.appendChild(separator); }
    const paragraph = document.createElement('span'); paragraph.className = 'rich-editor__paragraph'; paragraph.style.textAlign = p.align || 'left'; paragraph.dataset.bullet = String(!!p.bullet);
    p.runs.forEach(run => {
      const span = document.createElement('span'); span.textContent = run.text;
      for (const key of ['bold', 'italic', 'underline'] as const) span.dataset[key] = String(!!run[key]);
      span.style.fontWeight = run.bold ? '700' : '400'; span.style.fontStyle = run.italic ? 'italic' : 'normal'; span.style.textDecoration = run.underline ? 'underline' : 'none';
      paragraph.appendChild(span);
    }); if (!paragraph.childNodes.length) { paragraph.appendChild(document.createTextNode('')); const placeholder = document.createElement('br'); placeholder.dataset.placeholder = 'true'; paragraph.appendChild(placeholder); } root.appendChild(paragraph);
  });
}

export function RichTextEditor({ label, value, onChange, disabled = false, maxLength = 5000, fontFamily }: { label: string; value: RichText; onChange: (value: RichText) => void; disabled?: boolean; maxLength?: number; fontFamily?: string }) {
  const root = useRef<HTMLDivElement>(null), saved = useRef<Bookmark>({ start: 0, end: 0 });
  const current = useRef(value), composing = useRef(false);
  const history = useRef<RichText[]>([]), future = useRef<RichText[]>([]);
  const [revision, setRevision] = useState(0), [message, setMessage] = useState('');
  const pendingMarks = useRef<{ position: number; marks: TextMarks } | null>(null);
  const [activeMarks, setActiveMarks] = useState<TextMarks>(noTextMarks);
  const [activeBullet, setActiveBullet] = useState(false);
  function showMarks(marks: TextMarks) { setActiveMarks(old => old.bold === marks.bold && old.italic === marks.italic && old.underline === marks.underline ? old : marks); }
  useLayoutEffect(() => {
    const el = root.current; if (!el || composing.current) return;
    const focused = document.activeElement === el;
    paint(el, value); if (focused) restore(el, saved.current);
    current.current = value;
  }, [value, revision]);
  useEffect(() => {
    const listener = () => {
      const selection = root.current && bookmark(root.current); if (!selection) return;
      saved.current = selection;
      if (pendingMarks.current && (selection.start !== selection.end || selection.start !== pendingMarks.current.position)) pendingMarks.current = null;
      showMarks(pendingMarks.current?.marks || marksAtSelection(current.current, selection));
      const selected = selectedParagraphs(current.current, selection);
      setActiveBullet(!!selected.length && selected.every(i => current.current[i].bullet));
    };
    document.addEventListener('selectionchange', listener); return () => document.removeEventListener('selectionchange', listener);
  }, []);
  function commit(next: RichText, remember = true) {
    if (disabled) return;
    next = normalizeRichText(next);
    const limit = richTextLimit(next, maxLength);
    if (limit) { setMessage(limit); paint(root.current!, current.current); restore(root.current!, saved.current); return; }
    if (remember) { history.current.push(current.current); if (history.current.length > 60) history.current.shift(); future.current = []; }
    current.current = next; setMessage(''); onChange(next); setRevision(r => r + 1);
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
    const el = root.current!; saved.current = bookmark(el) || saved.current; el.focus(); restore(el, saved.current);
    const selection = window.getSelection()!, range = selection.getRangeAt(0); range.deleteContents();
    const node = document.createTextNode(text); range.insertNode(node); range.setStartAfter(node); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); input();
  }
  function mark(key: Mark) {
    saved.current = bookmark(root.current!) || saved.current;
    if (saved.current.start === saved.current.end) {
      const marks = pendingMarks.current?.marks || marksAtSelection(current.current, saved.current);
      const next = { ...marks, [key]: !marks[key] };
      pendingMarks.current = { position: saved.current.start, marks: next }; showMarks(next); setMessage('');
      root.current?.focus(); restore(root.current!, saved.current); return;
    }
    const next = formatRichSelection(current.current, saved.current, key);
    commit(next); showMarks(marksAtSelection(next, saved.current)); root.current?.focus();
  }
  function paragraph(change: { align?: 'left' | 'center' | 'right'; bullet?: boolean }) {
    saved.current = bookmark(root.current!) || saved.current;
    const value: RichText = current.current.length ? current.current : [{ runs: [] }];
    const selected = selectedParagraphs(value, saved.current);
    const patch = change.bullet === undefined ? change : { bullet: !selected.every(i => value[i].bullet) };
    const next = value.map((p, index) => selected.includes(index) ? { ...p, ...patch } : p);
    commit(next); setActiveBullet(!!selected.length && selected.every(i => next[i].bullet)); root.current?.focus();
  }
  function undo(redo = false) { pendingMarks.current = null; const from = redo ? future.current : history.current, to = redo ? history.current : future.current; const next = from.pop(); if (next) { to.push(current.current); commit(next, false); root.current?.focus(); } }
  return <div className="rich-editor">
    <div className="rich-editor__label">{label}</div>
    <div className="rich-editor__toolbar" role="group" aria-label={`Mise en forme : ${label}`} onMouseDown={e => e.preventDefault()}>
      {([['bold', Bold, 'Gras'], ['italic', Italic, 'Italique'], ['underline', Underline, 'Souligner']] as const).map(([key, Icon, title]) => <button key={key} type="button" title={title} aria-label={title} aria-pressed={activeMarks[key]} disabled={disabled} onClick={() => mark(key)}><Icon size={17} /></button>)}
      {([['left', AlignLeft, 'Aligner à gauche'], ['center', AlignCenter, 'Centrer'], ['right', AlignRight, 'Aligner à droite']] as const).map(([align, Icon, title]) => <button key={align} type="button" title={title} aria-label={title} disabled={disabled} onClick={() => paragraph({ align })}><Icon size={17} /></button>)}
      <button type="button" aria-label="Liste à puces" title="Liste à puces" aria-pressed={activeBullet} disabled={disabled} onClick={() => paragraph({ bullet: true })}><List size={17} /></button>
      <button type="button" aria-label="Annuler la modification du texte" title="Annuler" disabled={disabled || !history.current.length} onClick={() => undo()}><Undo2 size={17} /></button>
      <button type="button" aria-label="Rétablir la modification du texte" title="Rétablir" disabled={disabled || !future.current.length} onClick={() => undo(true)}><Redo2 size={17} /></button>
    </div>
    <div ref={root} className="rich-editor__surface" style={{ fontFamily }} contentEditable={!disabled} suppressContentEditableWarning role="textbox" aria-label={label} aria-multiline="true" aria-disabled={disabled} spellCheck onInput={input}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; input(); }}
      onBeforeInput={event => { const type = (event.nativeEvent as InputEvent).inputType; if (['insertParagraph', 'insertLineBreak'].includes(type)) { event.preventDefault(); insert('\n'); } else if (type === 'historyUndo' || type === 'historyRedo') { event.preventDefault(); undo(type === 'historyRedo'); } }}
      onPaste={event => { event.preventDefault(); insert(event.clipboardData.getData('text/plain')); }} onDrop={event => event.preventDefault()}
      onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); insert('\n'); } if (event.ctrlKey || event.metaKey) { const key = event.key.toLowerCase(); if (['b','i','u','z','y'].includes(key)) { event.preventDefault(); if (key === 'z' || key === 'y') undo(key === 'y' || event.shiftKey); else mark(({ b:'bold', i:'italic', u:'underline' } as const)[key as 'b'|'i'|'u']); } } }} />
    <small>Sélectionnez des mots, ou activez un style avant d’écrire. Entrée ajoute une ligne. {richPlainText(value).length}/{maxLength}</small>
    {message && <p role="status">{message}</p>}
  </div>;
}
