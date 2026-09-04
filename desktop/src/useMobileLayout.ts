import { useEffect } from 'react';

const mobileTableSelector = '.table-panel table';
const printSelector = '.print-root, .print-page, .print-preview, .invoice-print-preview';

/** Label only affected tables; timer ticks and unrelated forms do not rescan the workspace. */
export function useMobileLayout() {
  useEffect(() => {
    const media = window.matchMedia('(max-width: 860px)');
    const pending = new Set<HTMLTableElement>();
    let frame = 0;

    function labelTable(table: HTMLTableElement) {
      if (!table.isConnected || table.closest(printSelector)) return;
      const headings = Array.from(table.tHead?.rows[0]?.cells ?? []).map((cell) => cell.textContent?.trim() || cell.getAttribute('aria-label') || '');
      if (!headings.length) return;
      table.dataset.mobileCards = 'true';
      for (const body of Array.from(table.tBodies)) for (const row of Array.from(body.rows)) {
        const cells = Array.from(row.cells);
        if (cells.some((cell) => cell.colSpan > 1)) continue;
        cells.forEach((cell, index) => { cell.dataset.label = headings[index] || ''; });
      }
    }
    function collect(node: Node) {
      const element = node instanceof Element ? node : node.parentElement;
      if (!element) return;
      const table = element.closest<HTMLTableElement>(mobileTableSelector);
      if (table) pending.add(table);
      else element.querySelectorAll<HTMLTableElement>(mobileTableSelector).forEach((item) => pending.add(item));
    }
    function flush() {
      frame = 0;
      if (media.matches) pending.forEach(labelTable);
      pending.clear();
    }
    const observer = new MutationObserver((changes) => {
      if (!media.matches) return;
      for (const change of changes) {
        if (change.type === 'characterData') collect(change.target);
        else {
          const table = change.target instanceof Element ? change.target.closest<HTMLTableElement>(mobileTableSelector) : null;
          if (table) pending.add(table);
          else change.addedNodes.forEach(collect);
        }
      }
      if (pending.size && !frame) frame = requestAnimationFrame(flush);
    });
    // Dialogs render in body portals and share the same mobile table presentation.
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    const update = () => {
      if (media.matches) document.querySelectorAll<HTMLTableElement>(mobileTableSelector).forEach(labelTable);
    };
    media.addEventListener('change', update);
    update();
    const viewport = window.visualViewport;
    const resize = () => document.documentElement.classList.toggle('keyboard-open', !!viewport && window.innerHeight - viewport.height > 150);
    viewport?.addEventListener('resize', resize);
    resize();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); pending.clear(); media.removeEventListener('change', update); viewport?.removeEventListener('resize', resize); document.documentElement.classList.remove('keyboard-open'); };
  }, []);
}
