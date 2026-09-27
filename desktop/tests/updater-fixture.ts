import { desktopApi } from '../src/bridge';

export function installUpdaterFixture() {
  const notesVersion = new URLSearchParams(location.search).get('releaseHistory');
  const state = {
    installs: 0,
    checks: 0,
    available: true,
    offline: false,
    refuse: (_message?: string) => {},
  };
  Object.assign(window, { __updaterQA: state });
  desktopApi.getSecureUpdatePolicy = async () => ({
    enabled: notesVersion !== 'mobile', currentVersion: notesVersion === 'mobile' ? '1.63.0' : notesVersion || '1.29.0', channel: notesVersion === 'mobile' ? 'store' : 'stable',
    endpointHost: 'updates.example.invalid', signatureRequired: true,
    transport: 'HTTPS', automaticInstall: false, reason: notesVersion === 'mobile' ? 'Les mises à jour mobiles ne s’installent pas depuis cet écran. Utilisez la boutique ou l’outil avec lequel vous avez installé Zentra.' : '',
  });
  desktopApi.checkSecureUpdate = async () => {
    state.checks++;
    if (state.offline) throw new Error('Connexion de recette indisponible.');
    return state.available ? ({
    version: '1.30.0', currentVersion: '1.29.0', date: '2026-09-05',
    notes: 'Paquet simulé pour contrôler le panneau de mise à jour.',
    }) : null;
  };
  desktopApi.installSecureUpdate = async (onEvent) => {
    state.installs += 1;
    onEvent({ event: 'started', data: { contentLength: 1000 } });
    await new Promise<void>((_resolve, reject) => {
      state.refuse = (message = 'Téléchargement de recette interrompu.') => reject(new Error(message));
    });
  };
}
