import { documentAppearance, type DocumentDesignKind, type DocumentStyle } from './documentAppearance';
import { normalizeComposition, richPlainText, type DocumentComposition } from './documentComposition';
import type { AppSettings } from './types';
import { errorMessage } from './utils';

export const designKindLabels = { invoices: 'Factures', quotes: 'Devis', accounts: 'Bilan', payslips: 'Fiches de salaire' };
export const designKinds = Object.keys(designKindLabels) as DocumentDesignKind[];
export type DesignProblem = {
  kind: DocumentDesignKind;
  zone: 'intro' | 'closing' | 'footerText' | 'footer' | 'company' | 'page';
  title: string;
  message: string;
  range?: { start: number; end: number };
};
export type DesignExampleInput = { kind: DocumentDesignKind; style: DocumentStyle & { composition?: DocumentComposition }; issuer: Record<string, unknown> };

export function designExampleInput(settings: AppSettings, kind: DocumentDesignKind, issuer: Record<string, unknown>): DesignExampleInput {
  const composition = settings.documentComposition?.[kind];
  return { kind, issuer, style: { ...documentAppearance(settings.documentAppearance)[kind], ...(composition ? { composition: normalizeComposition(composition) } : {}) } };
}

/** Document fonts share Windows-1252 coverage. Return UTF-16 offsets for DOM selection. */
export function unsupportedDesignCharacter(text: string, multiline = true) {
  let start = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    const supported = code >= 0x20 && code <= 0x7e || code >= 0xa0 && code <= 0xff
      || '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.includes(character)
      || multiline && (character === '\n' || character === '\t');
    if (!supported) return { character, start, end: start + character.length };
    start += character.length;
  }
  return null;
}

export function documentDesignTextProblems(settings: AppSettings): DesignProblem[] {
  const problems: DesignProblem[] = [];
  for (const kind of designKinds) {
    const composition = normalizeComposition(settings.documentComposition?.[kind]);
    const zones = [
      ['intro', 'Introduction', richPlainText(composition.intro), 5000],
      ['closing', kind === 'accounts' ? 'Commentaire après les comptes' : 'Conditions et message de fin', richPlainText(composition.closing), 5000],
      ['footerText', 'Pied de page mis en forme', richPlainText(composition.footerText), 180],
      ['footer', 'Pied de page simple', documentAppearance(settings.documentAppearance)[kind].footer, 100],
    ] as const;
    for (const [zone, label, text, limit] of zones) {
      const title = `${designKindLabels[kind]} · ${label}`;
      const unsupported = unsupportedDesignCharacter(text, zone !== 'footer');
      if (unsupported) {
        const character = unsupported.character.codePointAt(0)! < 0x20 ? 'Un caractère invisible' : `Le caractère « ${unsupported.character} »`;
        problems.push({ kind, zone, title, range: { start: unsupported.start, end: unsupported.end }, message: `${character} ne peut pas être imprimé avec ces polices. Remplacez le passage sélectionné par du texte ou un symbole courant.` });
      } else if (Array.from(text).length > limit || zone !== 'footer' && composition[zone].length > 60) {
        problems.push({ kind, zone, title, message: `Raccourcissez cette zone : ${limit.toLocaleString('fr-CH')} caractères et 60 paragraphes maximum. Votre texte reste présent pendant la correction.` });
      }
    }
  }
  return problems;
}

export function nativeDesignProblem(kind: DocumentDesignKind, reason: unknown, settings: AppSettings): DesignProblem {
  const known = documentDesignTextProblems(settings).find(problem => problem.kind === kind);
  if (known) return known;
  const message = errorMessage(reason, 'L’aperçu est momentanément indisponible. Réessayez la vérification.');
  const footer = /pied de page/i.test(message);
  const company = /logo|caractère.*police/i.test(message);
  const zone = footer ? normalizeComposition(settings.documentComposition?.[kind]).footerText.length ? 'footerText' : 'footer' : company ? 'company' : 'page';
  return { kind, zone, title: `${designKindLabels[kind]} · ${footer ? 'Pied de page' : company ? 'Entreprise et logo' : 'Vérification du PDF'}`, message };
}

/** Validate each category with the native renderer before saving their shared settings. */
export async function validateDocumentDesigns(settings: AppSettings, issuer: Record<string, unknown>, render: (input: DesignExampleInput) => Promise<unknown>): Promise<DesignProblem[]> {
  const local = documentDesignTextProblems(settings);
  if (local.length) return local;
  const results = await Promise.allSettled(designKinds.map(kind => render(designExampleInput(settings, kind, issuer))));
  return results.flatMap((result, index) => result.status === 'rejected' ? [nativeDesignProblem(designKinds[index], result.reason, settings)] : []);
}
