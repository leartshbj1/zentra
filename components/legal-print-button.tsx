'use client';

export function LegalPrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="legal-print-button"
    >
      Imprimer ou enregistrer en PDF
    </button>
  );
}
