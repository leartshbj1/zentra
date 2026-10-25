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
