import { describe, expect, it, vi } from 'vitest';
import { initialOnboardingSettings } from './onboardingDraft';
import { normalizeComposition } from './documentComposition';
import { documentDesignTextProblems, nativeDesignProblem, unsupportedDesignCharacter, validateDocumentDesigns } from './documentDesignValidation';

describe('guided document validation', () => {
  it.each(['Léman · CHF 1’250.–', 'Œuvre, cœur, 20 € et 10 %', 'À bientôt\nDeuxième ligne\t• condition'])('accepts supported printable characters: %s', text => {
    expect(unsupportedDesignCharacter(text)).toBeNull();
  });
  it('returns a precise UTF-16 range after accented text and across paragraphs', () => {
    expect(unsupportedDesignCharacter('Délai\n📎 document')).toEqual({ character: '📎', start: 6, end: 8 });
    expect(unsupportedDesignCharacter('A\u0000B')).toMatchObject({ start: 1, end: 2 });
    expect(unsupportedDesignCharacter('1\n2', false)).toMatchObject({ start: 1, end: 2 });
  });
  it('names each document and field, including categories not currently visible', async () => {
    const settings = { ...initialOnboardingSettings, documentComposition: { quotes: normalizeComposition({ closing: [{ runs: [{ text: 'Merci 🧾' }] }] }), accounts: normalizeComposition({ intro: [{ runs: [{ text: 'Bilan ✅' }] }] }) } };
    const render = vi.fn();
    const problems = await validateDocumentDesigns(settings, {}, render);
    expect(problems.map(p => [p.kind,p.zone])).toEqual([['quotes','closing'],['accounts','intro']]);
    expect(problems[0].title).toContain('Devis'); expect(problems[1].title).toContain('Bilan');
    expect(render).not.toHaveBeenCalled();
  });
  it('reports footer length and paragraph limits without truncating the settings', () => {
    const settings = { ...initialOnboardingSettings, documentComposition: { payslips: normalizeComposition({ footerText: [{ runs: [{ text: 'a'.repeat(181) }] }], intro: Array.from({length:61}, () => ({ runs: [{ text:'ligne' }] })) }) } };
    const before = JSON.stringify(settings);
    expect(documentDesignTextProblems(settings).map(p => p.zone)).toEqual(['intro','footerText']);
    expect(JSON.stringify(settings)).toBe(before);
  });
  it('checks every renderer and associates all native failures with the right category', async () => {
    const render = vi.fn(async (input: { kind: string }) => {
      if (input.kind === 'quotes') throw new Error('Le pied de page dépasse quatre lignes.');
      if (input.kind === 'payslips') throw new Error('Le logo est introuvable.');
      return [37,80,68,70];
    });
    const problems = await validateDocumentDesigns(initialOnboardingSettings, {company_name:'Entreprise'}, render);
    expect(render.mock.calls.map(call => call[0].kind)).toEqual(['invoices','quotes','accounts','payslips']);
    expect(problems.map(p => [p.kind,p.zone])).toEqual([['quotes','footer'],['payslips','company']]);
  });
  it('routes a tall formatted footer to its editor and preserves the native explanation', () => {
    const settings = { ...initialOnboardingSettings, documentComposition: { invoices: normalizeComposition({ footerText: [{ runs: [{ text:'Un pied de page',fontSize:24 }] }] }) } };
    expect(nativeDesignProblem('invoices',new Error('Le pied de page prend trop de place.'),settings)).toMatchObject({zone:'footerText',message:'Le pied de page prend trop de place.'});
  });
  it('sends normalized layout and the issuer to the native checks without creating a design for untouched categories', async () => {
    const settings = { ...initialOnboardingSettings, documentComposition: { quotes: normalizeComposition({ fontFamily:'times', closingOnNewPage:true }) } };
    const render=vi.fn(async()=>[]);
    expect(await validateDocumentDesigns(settings,{company_name:'Exemple'},render)).toEqual([]);
    const calls=render.mock.calls as unknown as Array<[any]>;
    expect(calls[1][0]).toMatchObject({kind:'quotes',issuer:{company_name:'Exemple'},style:{composition:{fontFamily:'times',closingOnNewPage:true}}});
    expect(calls[0][0].style).not.toHaveProperty('composition');
  });
});
