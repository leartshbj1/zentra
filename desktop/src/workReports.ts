// Rapports de régie : totaux affichés (le natif recalcule la facture), trait
// de signature en chemin SVG compact, et rapports signés à facturer.
import type { WorkReport, WorkReportLine } from './types';

const roundBp = (cents: number, bp: number) => {
  const value = Math.abs(cents) * bp;
  return Math.sign(cents) * Math.floor((value + 5_000) / 10_000);
};

export function lineNetCents(line: Pick<WorkReportLine, 'quantity' | 'unitPriceCents'>): number {
  return Math.round(line.quantity * line.unitPriceCents);
}

/** Totaux du rapport : TVA ligne par ligne, arrondie au centime (demi supérieur), comme la facture. */
export function reportTotals(lines: readonly Pick<WorkReportLine, 'kind' | 'quantity' | 'unitPriceCents' | 'vatBp'>[]) {
  let net = 0, vat = 0, hours = 0, materials = 0;
  for (const line of lines) {
    const lineNet = lineNetCents(line);
    net += lineNet;
    vat += roundBp(lineNet, line.vatBp);
    if (line.kind === 'labor') hours += line.quantity;
    else materials += 1;
  }
  return { netCents: net, vatCents: vat, totalCents: net + vat, hours: Math.round(hours * 100) / 100, materials };
}

export type Point = { x: number; y: number };

/** Traits → chemin SVG sur une toile de 600 × 200, coordonnées entières, points trop proches retirés. */
export function signaturePath(strokes: readonly (readonly Point[])[], width: number, height: number): string {
  const sx = 600 / Math.max(width, 1), sy = 200 / Math.max(height, 1);
  const parts: string[] = [];
  for (const stroke of strokes) {
    let last: Point | null = null;
    stroke.forEach((point, index) => {
      const x = Math.round(Math.min(Math.max(point.x * sx, 0), 600)), y = Math.round(Math.min(Math.max(point.y * sy, 0), 200));
      if (last && index < stroke.length - 1 && Math.abs(x - last.x) + Math.abs(y - last.y) < 2) return;
      parts.push(`${parts.length && index > 0 ? 'L' : 'M'}${x} ${y}`);
      last = { x, y };
    });
  }
  return parts.join(' ');
}

/** Assez de trait pour valoir une signature (le natif vérifie aussi). */
export function signatureReady(path: string): boolean {
  return path.length >= 10 && (path.match(/L/g) ?? []).length >= 2;
}

export function reportsToInvoice(reports: readonly WorkReport[]): WorkReport[] {
  return reports.filter((report) => report.status === 'signed' && !report.invoiceId);
}
