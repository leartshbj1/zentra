import './appearance';
import './textSize';
import { ZentraAssistantProvider } from './ZentraAssistant';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import {installDiagnosticCapture} from './diagnostics';
import { installFullscreenShortcuts } from './windowFullscreen';
import {DiagnosticBoundary} from './DiagnosticBoundary';
import { LanguageBoot } from './LanguageStatus';
import './styles.css';
import './workspace-design.css';
import './mobile.css';
import './experience.css';
import './workspace-shell.css';
import './guided-tour.css';
import './clarity.css';
import './refined.css';
import './assistant.css';

const root = document.getElementById('root');
installDiagnosticCapture();
installFullscreenShortcuts();
if (!root) throw new Error('Le point de montage de l’application est introuvable.');
// The grouped design (design-b.css) and its motion (motion.css) key on this attribute.
// Not on iPhone and iPad: 1.90.58 made the iOS web view restart in a loop a few seconds after
// opening, so iOS keeps the 1.90.57 look until that design is proven on a device.
const appleTouch = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (!appleTouch) document.documentElement.dataset.design = 'b';

createRoot(root).render(
  <StrictMode>
    <DiagnosticBoundary><LanguageBoot><ZentraAssistantProvider><App /></ZentraAssistantProvider></LanguageBoot></DiagnosticBoundary>
  </StrictMode>,
);

import './dark.generated.css';
import './dark.css';
import './mobile-air.css';
import './automation-design.css';
import './workspace-atelier.css';
import './onboarding-journey.css';
import './workspace-personalization.css';
import './brand-identity.css';

import './mobile-collections.css';
import './apple-workspace.css';
import './apple-business.css';
import './apple-operational.css';
import './apple-secondary.css';
import './apple-access.css';
import './clarity-2026.css';
import './zentra-2027.css';
import './zentra-2027-pages.css';
import './zentra-2027-sober.css';
import './zentra-2027-menus.css';
import './zentra-2027-calm.css';
import './autopilot-simple.css';
import './filters-calm.css';
import './switch-calm.css';
import './erp-calm.css';
import './autopilot-magic.css';
import './mobile-calm.css';
import './agenda-calm.css';
import './parcours-client.css';
import './pack-batiment.css';
import './aere.css';
import './autopilot-aujourdhui.css';
import './autopilot-nouveautes.css';
import './design-b.css';
import './motion.css';
import './menus-2026.css';
