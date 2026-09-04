import { useEffect } from 'react';

/** Adds visible labels to dense, existing tables without changing their data or desktop layout. */
export function useMobileLayout() {
  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)');
    function labelTables(root: ParentNode = document) {
      if (!media.matches) return;
      root.querySelectorAll<HTMLTableElement>('.table-panel table').forEach((table) => {
        const headings = Array.from(table.tHead?.rows[0]?.cells ?? []).map((cell) => cell.textContent?.trim() || cell.getAttribute('aria-label') || '');
        if (!headings.length || table.closest('.print-root, .print-page, .print-preview, .invoice-print-preview')) return;
        table.dataset.mobileCards = 'true';
        for (const body of Array.from(table.tBodies)) for (const row of Array.from(body.rows)) {
          if (Array.from(row.cells).some((cell) => cell.colSpan > 1)) continue;
          Array.from(row.cells).forEach((cell, index) => { cell.dataset.label = headings[index] || ''; });
        }
      });
    }
    let frame = 0;
    const observer = new MutationObserver((changes) => {
      if (!media.matches || !changes.some((change) => change.addedNodes.length)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => labelTables());
    });
    observer.observe(document.getElementById('root')!, { childList: true, subtree: true });
    const update = () => labelTables();
    media.addEventListener('change', update);
    labelTables();
    const viewport = window.visualViewport;
    const resize = () => document.documentElement.classList.toggle('keyboard-open', !!viewport && window.innerHeight - viewport.height > 150);
    viewport?.addEventListener('resize', resize);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); media.removeEventListener('change', update); viewport?.removeEventListener('resize', resize); document.documentElement.classList.remove('keyboard-open'); };
  }, []);
}
