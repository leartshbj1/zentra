import { normalizeRichText, richPlainText, type RichParagraph, type RichRun, type RichText } from './documentComposition';

type Marks = Omit<RichRun, 'text'>;
const omitted = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'IMG', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'TEMPLATE', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA']);
const blocks = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'LI', 'TR']);

function color(value: string): string | undefined {
  if (/^#[\da-f]{6}$/i.test(value)) return value.toLowerCase();
  const short = /^#([\da-f])([\da-f])([\da-f])$/i.exec(value);
  if (short) return `#${short.slice(1).map(c => c + c).join('')}`.toLowerCase();
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*1(?:\.0+)?)?\s*\)$/.exec(value);
  return rgb && rgb.slice(1).every(n => Number(n) <= 255) ? `#${rgb.slice(1).map(n => Number(n).toString(16).padStart(2, '0')).join('')}` : undefined;
}

function marksFor(element: HTMLElement, inherited: Marks): Marks {
  const marks = { ...inherited }, css = element.style;
  if (/^(B|STRONG)$/.test(element.tagName)) marks.bold = true;
  if (/^(I|EM)$/.test(element.tagName)) marks.italic = true;
  if (element.tagName === 'U') marks.underline = true;
  if (/^H[1-6]$/.test(element.tagName)) { marks.bold = true; marks.fontSize = [24, 20, 18, 16, 14, 12][Number(element.tagName[1]) - 1]; }
  if (css.fontWeight) marks.bold = css.fontWeight === 'bold' || Number(css.fontWeight) >= 600;
  if (css.fontStyle) marks.italic = /italic|oblique/.test(css.fontStyle);
  if (css.textDecoration || css.textDecorationLine) marks.underline = /underline/.test(css.textDecoration + css.textDecorationLine);
  const family = css.fontFamily.toLowerCase();
  if (family) marks.fontFamily = /courier|consolas|monaco|monospace/.test(family) ? 'courier' : /times|georgia|cambria|serif/.test(family.replace(/sans-serif/g, '')) ? 'times' : 'helvetica';
  const size = /^(\d+(?:\.\d+)?)(pt|px)$/.exec(css.fontSize);
  if (size) marks.fontSize = Math.max(8, Math.min(24, Math.round(Number(size[1]) * (size[2] === 'px' ? .75 : 1) * 2) / 2));
  const ownSize = Number(element.dataset.fontSize);
  if (ownSize >= 8 && ownSize <= 24) marks.fontSize = ownSize;
  const ink = color(css.color), highlight = color(css.backgroundColor);
  if (ink) marks.color = ink;
  if (highlight) marks.highlight = highlight;
  if (element.tagName === 'MARK' && !highlight) marks.highlight = '#fff0a6';
  return marks;
}

/** Read an inert clipboard fragment; no pasted node, CSS or URL enters the live document. */
export function richTextFromClipboard(html: string): RichText | null {
  if (!html || html.length > 200_000) return null;
  const template = document.createElement('template');
  template.innerHTML = html;
  const paragraphs: RichText = [];
  let current: RichParagraph | null = null;
  let visited = 0;
  const flush = () => { if (current) paragraphs.push(current); current = null; };
  const append = (text: string, marks: Marks, format: Omit<RichParagraph, 'runs'>) => {
    if (!text) return;
    if (!current) current = { ...format, runs: [] };
    current.runs.push({ text, ...marks });
  };
  const walk = (node: Node, inherited: Marks, format: Omit<RichParagraph, 'runs'>, depth: number, preserveSpaces = false) => {
    if (++visited > 12_000 || depth > 80) throw new Error('clipboard-limit');
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      if (!preserveSpaces && !text.trim() && /[\r\n]/.test(text)) return;
      append(preserveSpaces ? text : text.replace(/[\t\r\n ]+/g, ' '), inherited, format);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (omitted.has(el.tagName) || el.hidden || el.style.display === 'none') return;
    if (el.tagName === 'BR') { if (!current) current = { ...format, runs: [] }; flush(); current = { ...format, runs: [] }; return; }
    const marks = marksFor(el, inherited);
    const align = el.style.textAlign || el.getAttribute('align');
    const ownParagraph = el.classList.contains('rich-editor__paragraph');
    const nextFormat = { ...format, ...(['left', 'center', 'right'].includes(align || '') ? { align: align as RichParagraph['align'] } : {}), ...(el.tagName === 'LI' ? { bullet: el.parentElement?.tagName !== 'OL' } : ownParagraph ? { bullet: el.dataset.bullet === 'true' } : {}) };
    const block = blocks.has(el.tagName) || ownParagraph || el.style.display === 'block';
    if (block) flush();
    const firstParagraph = paragraphs.length;
    el.childNodes.forEach(child => walk(child, marks, nextFormat, depth + 1, preserveSpaces || el.tagName === 'PRE' || /pre/.test(el.style.whiteSpace)));
    if (block) { if (!current && !el.childNodes.length) current = { ...nextFormat, runs: [] }; flush(); }
    if (el.tagName === 'LI' && el.parentElement?.tagName === 'OL' && paragraphs[firstParagraph]) {
      const siblings = [...el.parentElement.children].filter(child => child.tagName === 'LI');
      const first = Number(el.parentElement.getAttribute('start') || 1);
      paragraphs[firstParagraph].runs.unshift({ ...marks, text: `${(Number.isSafeInteger(first) ? first : 1) + siblings.indexOf(el)}. ` });
    }
    if (/^(TD|TH)$/.test(el.tagName) && el.nextElementSibling) append('  ', marks, nextFormat);
  };
  try { template.content.childNodes.forEach(node => walk(node, {}, { align: 'left', bullet: false }, 0)); flush(); }
  catch { return null; }
  // A trailing BR is an editor placeholder; keep intentional empty paragraphs inside the text.
  while (paragraphs.length > 1 && !richPlainText([paragraphs.at(-1)!])) paragraphs.pop();
  const result = normalizeRichText(paragraphs);
  return richPlainText(result).trim() ? result : null;
}
