import { describe, expect, it } from 'vitest';
import { payrollPreparationTasks } from './payrollPreparationTasks';
import { payrollHelp } from './payrollHelp';

describe('préparation de la première fiche', () => {
  it('ouvre les accidents hors travail quand les heures sont déjà renseignées', () => {
    expect(
      payrollHelp(
        'Le collaborateur atteint 8 h/semaine: la couverture AANP doit être configurée.',
      ),
    ).toMatchObject({
      target: 'contributions',
      selector: '[data-payroll-preset="aanp"]',
    });
  });
  it('ne confond pas une AAP manquante avec une demande de petits salaires', () => {
    expect(
      payrollHelp(
        'La prime accidents professionnels AAP doit être configurée, sauf exception annuelle des petits salaires vérifiée pour toute l’entreprise.',
      ),
    ).toMatchObject({
      target: 'contributions',
      selector: '[data-payroll-preset="aap"]',
    });
  });
  it('garde la CAF distincte de l’AVS même quand son message cite le salaire AVS', () => {
    expect(
      payrollPreparationTasks([
        'Chaque cotisation CAF doit utiliser le taux positif documenté de la caisse, le salaire soumis AVS et aucun plafond annuel libre.',
      ])[0],
    ).toMatchObject({
      id: 'contributions-family_allowance',
      selector: '[data-payroll-preset="family_allowance"]',
    });
  });
  it('ordonne le contrat et le début d’année avant les cotisations, sans masquer de diagnostic', () => {
    const messages = [
      'La couverture LPP obligatoire doit inclure la composante risque.',
      'La date de naissance manque; Zentra ne peut pas contrôler AVS, AC et LPP.',
      'Configurez la décision annuelle « salaire de minime importance » sur la fiche collaborateur, avec des ouvertures explicites même lorsqu’elles valent zéro.',
      'La date d’entrée manque.',
      'La date d’entrée manque.',
    ];
    const tasks = payrollPreparationTasks(messages);
    expect(tasks.map((task) => task.target)).toEqual([
      'person',
      'history',
      'pension-contributions',
    ]);
    expect(tasks.flatMap((task) => task.messages).sort()).toEqual(
      [...new Set(messages)].sort(),
    );
  });
  it('prépare les taux fédéraux sans demander une police privée', () => {
    expect(
      payrollPreparationTasks([
        'La cotisation fédérale AVS_EMPLOYEE manque.',
      ])[0],
    ).toMatchObject({
      id: 'contributions-federal',
      selector: '[data-payroll-preset="federal"]',
    });
  });
  it('ne transforme pas un profil complet en nouvel obstacle', () => {
    expect(payrollPreparationTasks([])).toEqual([]);
  });
});
