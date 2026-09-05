import { desktopApi } from '../src/bridge';

export function installUpdaterFixture() {
  const state = {
    installs: 0,
    refuse: () => {},
  };
  Object.assign(window, { __updaterQA: state });
  desktopApi.getSecureUpdatePolicy = async () => ({
    enabled: true, currentVersion: '1.29.0', channel: 'stable',
    endpointHost: 'updates.example.invalid', signatureRequired: true,
    transport: 'HTTPS', automaticInstall: false, reason: '',
  });
  desktopApi.checkSecureUpdate = async () => ({
    version: '1.30.0', currentVersion: '1.29.0', date: '2026-09-05',
    notes: 'Paquet simulé pour contrôler le panneau de mise à jour.',
  });
  desktopApi.installSecureUpdate = async (onEvent) => {
    state.installs += 1;
    onEvent({ event: 'started', data: { contentLength: 1000 } });
    await new Promise<void>((_resolve, reject) => {
      state.refuse = () => reject(new Error('Téléchargement de recette interrompu.'));
    });
  };
}
