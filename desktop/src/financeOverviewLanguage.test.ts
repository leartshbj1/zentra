import './languageTestPacks';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { billingPresets } from './financeClarity';
import { t } from './language';
import { translations } from './translations';
import { financeOverviewTranslations } from './translationsFinanceOverview';

const confirmation = '{paymentDays} jours pour régler une facture, {validityDays} jours pour accepter un devis.';

function explicitInterfaceKeys(file = 'FinanceOverview.tsx') {
  const ast = ts.createSourceFile(
    file,
    readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const keys = new Set<string>();
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
      const source = node.arguments[0];
      if (source && ts.isStringLiteralLike(source)) keys.add(source.text.trim());
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return [...keys];
}

describe('financial overview language catalogue', () => {
  it('covers direct messages, messages translated by child components, steps and billing presets', () => {
    const direct = explicitInterfaceKeys();
    expect(direct).toContain(confirmation);
    const keys = [
      ...direct,
      // FinanceFirstStep and ErrorPanel translate their source props at display time.
      'Préparez votre comptabilité',
      'Un administrateur peut préparer les comptes. Vous pouvez consulter la configuration.',
      'Choisissez les comptes qui recevront vos ventes, achats et paiements. Vous vérifierez leur activation avant tout enregistrement.',
      'Voir la configuration',
      'Préparer les comptes',
      'La configuration de l’entreprise est indisponible.',
      'La configuration n’a pas pu être enregistrée. Vos choix sont conservés.',
      'Choisir',
      'Vérifier',
      ...billingPresets.flatMap(preset => [preset.name, preset.text]),
    ];
    expect(keys.filter(key => !translations[key])).toEqual([]);
    for (const key of keys) {
      expect(translations[key], key).toHaveLength(3);
      for (const target of translations[key]) expect(target.trim(), key).not.toBe('');
    }
  });

  it('covers accounting navigation, period controls and indirect toolbar labels', () => {
    const keys = [
      ...explicitInterfaceKeys('AccountingScreen.tsx'),
      'Vue d’ensemble', 'Immobilisations', 'Journal', 'Grand livre', 'Balance', 'Bilan',
      'Résultat', 'TVA', 'Dossier de clôture', 'Plan & liaisons', 'Exercices',
      'Section comptable', 'Période de la vue d’ensemble', 'Période', 'Ce mois',
      'Ce trimestre', 'Cette année', 'Période personnalisée', 'Comptabilité détaillée',
      'Autres outils comptables', 'Choisir un outil…', 'Choisir une période rapidement',
      'Toutes les dates', 'Actualisation…', 'Clôturé', 'Provisoire', 'Actualiser',
      'Les états ont été actualisés.', 'Exercice ou période', 'Exercice ou période comptable',
      'Période libre', 'clôturé', 'ouvert', 'Du', 'Au', 'Date de début de la période',
      'Date de fin de la période', 'Depuis le {date}', 'Jusqu’au {date}',
    ];
    expect(keys.filter(key => !translations[key])).toEqual([]);
    for (const key of keys) {
      expect(translations[key], key).toHaveLength(3);
      for (const target of translations[key]) expect(target.trim(), key).not.toBe('');
    }
  });

  it('preserves all named parameters in the authored translations', () => {
    const parameters = (message: string) => [...message.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map(match => match[1]).sort();
    for (const [source, row] of Object.entries(financeOverviewTranslations)) {
      expect(row, source).toHaveLength(3);
      for (const target of row) {
        expect(target.trim(), source).not.toBe('');
        expect(parameters(target), source).toEqual(parameters(source));
      }
    }
  });

  it('renders distinct payment and quote durations in all four languages', () => {
    const values = { paymentDays: 14, validityDays: 30 };
    expect(t(confirmation, values, 'fr')).toBe('14 jours pour régler une facture, 30 jours pour accepter un devis.');
    expect(t(confirmation, values, 'de')).toBe('14 Tage zum Bezahlen einer Rechnung, 30 Tage zum Annehmen einer Offerte.');
    expect(t(confirmation, values, 'it')).toBe('14 giorni per pagare una fattura, 30 giorni per accettare un preventivo.');
    expect(t(confirmation, values, 'en')).toBe('14 days to pay an invoice, 30 days to accept a quote.');
    expect(['fr', 'de', 'it', 'en'].map(language => t('jours', undefined, language as 'fr' | 'de' | 'it' | 'en'))).toEqual(['jours', 'Tage', 'giorni', 'days']);
  });

  it('keeps the supplied date intact in each translated open-ended period label', () => {
    const date = '29.09.2026';
    for (const language of ['fr', 'de', 'it', 'en'] as const) {
      for (const source of ['Depuis le {date}', 'Jusqu’au {date}']) {
        const label = t(source, { date }, language);
        expect(label).toContain(date);
        expect(label).not.toContain('{date}');
        if (language !== 'fr') expect(label).not.toBe(t(source, { date }, 'fr'));
      }
    }
  });
});
