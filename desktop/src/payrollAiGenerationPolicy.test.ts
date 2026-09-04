import { describe, expect, it } from 'vitest';
import {
  firstCompleteGeneratedJson,
  payrollAiGenerationPercent,
  payrollAiGenerationPlan,
  payrollAiSafePageBatches,
  payrollAiSafePageBatchSize,
} from './payrollAiGenerationPolicy';

describe('strategie de generation SmolVLM locale', () => {
  it('garde deux lectures riches sur WebGPU et borne le travail CPU/WASM', () => {
    const gpu = payrollAiGenerationPlan('webgpu');
    const cpu = payrollAiGenerationPlan('wasm');

    expect(gpu).toMatchObject({ passes: 2, pagesPerBatch: 3, maxNewTokens: 1_100 });
    expect(cpu).toMatchObject({
      passes: 1,
      pagesPerBatch: 1,
      maxNewTokens: 384,
      phaseTokenBudgets: { core: 96, lines: 288 },
      splitImagesWhenTextAvailable: false,
    });
    expect((cpu.phaseTokenBudgets?.core ?? 0) + (cpu.phaseTokenBudgets?.lines ?? 0)).toBe(cpu.maxNewTokens);
    expect(cpu.maxNewTokens).toBeLessThan(gpu.maxNewTokens);
  });

  it('resegmente trois pages avant un possible repli WebGPU vers WASM', () => {
    expect(payrollAiSafePageBatchSize('webgpu')).toBe(1);
    expect(payrollAiSafePageBatches(['page-1', 'page-2', 'page-3'], 'webgpu')).toEqual([
      ['page-1'],
      ['page-2'],
      ['page-3'],
    ]);
    expect(payrollAiSafePageBatches(['page-1', 'page-2'], 'wasm')).toEqual([
      ['page-1'],
      ['page-2'],
    ]);
  });

  it('arrete au premier objet JSON complet, meme avec imbrication et cloture Markdown', () => {
    const raw = '```json\n{"employee":{"name":"Ada"},"lines":[{"label":"AVS"}]}\n``` texte inutile';
    expect(firstCompleteGeneratedJson(raw)).toBe('{"employee":{"name":"Ada"},"lines":[{"label":"AVS"}]}');
  });

  it('ignore les accolades et guillemets echappes dans les chaines', () => {
    const raw = String.raw`avant {"warnings":["texte } et \"{\" conserve"],"gross_cents":650000} apres`;
    expect(firstCompleteGeneratedJson(raw)).toBe(String.raw`{"warnings":["texte } et \"{\" conserve"],"gross_cents":650000}`);
  });

  it('reconnait le dict Python-like reel sans confondre apostrophes et accolades de valeur', () => {
    const raw = "{'employee': {'name': 'D'Amico {atelier}'}, 'gross_cents': '6'500.00', 'lines': []} commentaire";
    expect(firstCompleteGeneratedJson(raw)).toBe("{'employee': {'name': 'D'Amico {atelier}'}, 'gross_cents': '6'500.00', 'lines': []}");
  });

  it('ignore les apostrophes du commentaire avant la racine Python-like', () => {
    const raw = "Voici l'objet: {'employee': {'name': 'Ada'}, 'lines': []}";
    expect(firstCompleteGeneratedJson(raw)).toBe("{'employee': {'name': 'Ada'}, 'lines': []}");
  });

  it('ferme les montants Python-like auxquels SmolVLM omet la derniere apostrophe', () => {
    const observed = "{'employee_name': 'Élodie Exemple', 'gross_cents': '6'500.00, 'net_cents': '6'284.00}";
    expect(firstCompleteGeneratedJson(observed)).toBe(observed);
  });

  it('ne valide jamais un objet tronque', () => {
    expect(firstCompleteGeneratedJson('{"employee":{"name":"Ada"}')).toBeNull();
    expect(firstCompleteGeneratedJson('aucun objet')).toBeNull();
  });

  it('produit une progression monotone et strictement bornee', () => {
    const percent = (generatedTokens: number) => payrollAiGenerationPercent({
      generatedTokens,
      maxNewTokens: 384,
      startPercent: 55,
      endPercent: 96,
    });

    expect([-10, 0, 96, 192, 384, 900].map(percent)).toEqual([55, 55, 65, 75, 96, 96]);
  });
});
