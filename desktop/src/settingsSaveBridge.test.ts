import { afterEach, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke }));
import { desktopApi } from './bridge';
import { initialOnboardingSettings } from './onboardingDraft';
import { normalizeComposition } from './documentComposition';
import { WorkspaceRefreshAfterMutationError } from './workspaceMutation';
afterEach(() => invoke.mockReset());

it('distinguishes an acknowledged settings write from its failed refresh', async () => {
  invoke.mockImplementation(async command => {
    if(command === 'update_settings') return {};
    throw new Error('Lecture indisponible');
  });
  await expect(desktopApi.saveSettings(initialOnboardingSettings)).rejects.toBeInstanceOf(WorkspaceRefreshAfterMutationError);
  expect(invoke.mock.calls.map(call => call[0])).toEqual(['update_settings','get_app_state']);
});
it('does not claim success for a native refusal and sends no follow-up write', async () => {
  const reason = new Error('Les paramètres ne sont pas valides.');
  invoke.mockRejectedValue(reason);
  await expect(desktopApi.saveSettings(initialOnboardingSettings)).rejects.toBe(reason);
  expect(invoke).toHaveBeenCalledTimes(1);
});
it('persists all document categories and their layout in the actual native payload', async () => {
  invoke.mockImplementation(async command => {
    if(command === 'update_settings') return {};
    if(command === 'get_app_state') return {onboarding_completed:true};
    if(command === 'get_workspace') return { settings: {company_name:'Entreprise',extra_settings_json:'{}'} };
    throw new Error(`Unexpected command: ${command}`);
  });
  const composition = normalizeComposition({ companyAlign:'center', fontFamily:'times', closingOnNewPage:true, intro:[{runs:[{text:'Texte sauvegardé',bold:true}]}] });
  await desktopApi.saveSettings({ ...initialOnboardingSettings, documentComposition: { invoices:composition,quotes:composition,accounts:composition,payslips:composition } });
  const extra=JSON.parse(invoke.mock.calls[0][1].data.extra_settings_json);
  expect(Object.keys(extra.documentComposition)).toEqual(['invoices','quotes','accounts','payslips']);
  expect(extra.documentComposition.quotes).toEqual(composition);
  expect(invoke.mock.calls.filter(call=>call[0]==='update_settings')).toHaveLength(1);
});
it('treats an empty onboarding response after acknowledgement as a failed read', async () => {
  invoke.mockImplementation(async command => command === 'update_settings' ? {} : {onboarding_completed:false});
  await expect(desktopApi.saveSettings(initialOnboardingSettings)).rejects.toBeInstanceOf(WorkspaceRefreshAfterMutationError);
  expect(invoke.mock.calls.filter(call=>call[0]==='update_settings')).toHaveLength(1);
});
