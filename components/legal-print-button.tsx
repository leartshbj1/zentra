'use client';

export function LegalPrintButton() {
  return <button type="button" onClick={() => window.print()} className="legal-print-button min-h-11 rounded-full border border-[#d2d2d7] px-5 py-2 text-sm font-semibold hover:bg-white">Imprimer ou enregistrer en PDF</button>;
}
