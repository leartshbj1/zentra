import { documentAppearance, type DocumentDesignKind, type DocumentStyle } from './documentAppearance';
import { normalizeComposition, type DocumentComposition } from './documentComposition';
import type { AppSettings } from './types';
import { documentDesignTextProblems } from './documentDesignValidation';

export type DocumentDesignTemplate = {
  version: 1;
  id: string;
  name: string;
  sourceKind: DocumentDesignKind;
  style: DocumentStyle & { composition?: DocumentComposition };
};
export const maxDocumentTemplates = 20;
export const documentKindLabels = { invoices: 'Factures', quotes: 'Devis', accounts: 'Bilan', payslips: 'Fiches de salaire' };
export const documentKindTargets = { invoices: 'aux factures', quotes: 'aux devis', accounts: 'au bilan', payslips: 'aux fiches de salaire' };

export function templateNameError(name: string, templates: DocumentDesignTemplate[], exceptId?: string): string | null {
  if (!name.trim()) return 'Donnez un nom à ce modèle, par exemple « Devis classique ».';
  if (Array.from(name.trim()).length > 60 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) return 'Utilisez un nom de 60 caractères maximum, sur une seule ligne.';
  if (templates.some(item => item.id !== exceptId && item.name.toLowerCase() === name.trim().toLowerCase())) return 'Vous avez déjà un modèle avec ce nom. Choisissez un autre nom.';
  return null;
}

/** A template contains presentation and model text only; never company identity, files or amounts. */
export function captureDocumentTemplate(settings: AppSettings, kind: DocumentDesignKind, name: string, id: string): DocumentDesignTemplate {
  const templates = settings.documentDesignTemplates ?? [];
  const problem = templateNameError(name, templates);
  if (problem) throw new Error(problem);
  if (templates.length >= maxDocumentTemplates) throw new Error('Vos 20 modèles sont déjà créés. Retirez un modèle inutilisé avant d’en ajouter un.');
  const textProblem = documentDesignTextProblems(settings).find(item => item.kind === kind);
  if (textProblem) throw new Error(`Avant de créer ce modèle, corrigez ${textProblem.title.toLowerCase()} dans Textes. ${textProblem.message}`);
  return structuredClone({ version: 1, id, name: name.trim(), sourceKind: kind,
    style: { ...documentAppearance(settings.documentAppearance)[kind],
      ...(settings.documentComposition?.[kind] ? { composition: settings.documentComposition[kind] } : {}),
    },
  });
}

export function applyDocumentTemplate(settings: AppSettings, kind: DocumentDesignKind, template: DocumentDesignTemplate, includeText = false): AppSettings {
  const appearance = documentAppearance(settings.documentAppearance);
  const { composition: source, ...style } = template.style;
  const target = normalizeComposition(settings.documentComposition?.[kind]);
  const composition = includeText ? source : { ...normalizeComposition(source), intro: target.intro, closing: target.closing, footerText: target.footerText };
  const documentComposition = { ...settings.documentComposition };
  if (composition) documentComposition[kind] = structuredClone(composition); else delete documentComposition[kind];
  return { ...settings, documentComposition,
    documentAppearance: { ...appearance, [kind]: { ...style, footer: includeText ? style.footer : appearance[kind].footer } },
  };
}
