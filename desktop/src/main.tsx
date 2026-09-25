import './appearance';
import { ZentraAssistantProvider } from './ZentraAssistant';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
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
if (!root) throw new Error('Le point de montage de l’application est introuvable.');

createRoot(root).render(
  <StrictMode>
    <ZentraAssistantProvider><App /></ZentraAssistantProvider>
  </StrictMode>,
);

import './dark.generated.css';
import './dark.css';
import './mobile-air.css';
import './automation-design.css';
import './workspace-atelier.css';
import './onboarding-journey.css';
import './workspace-personalization.css';
