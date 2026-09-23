'use client';

import { useEffect, useId, useState } from 'react';
import {
  ArrowRight,
  CalendarDays,
  Check,
  ChevronRight,
  FileText,
  Mail,
  Pause,
  Play,
  RotateCcw,
  Users,
} from 'lucide-react';
import './product-story.css';

const stories = [
  {
    label: 'Une facture',
    icon: FileText,
    title: 'De la boîte mail aux achats.',
    intro:
      'La facture reçue retrouve son fournisseur et sa place dans Gestion.',
    subject: 'Votre facture de fournitures',
    sender: 'Atelier Léman · Fournisseur fictif',
    message:
      'Bonjour, voici la facture AL-2048 pour votre commande de fournitures.',
    attachment: 'Facture AL-2048.pdf',
    category: 'Facture fournisseur',
    details: [
      ['Fournisseur', 'Atelier Léman'],
      ['Référence', 'AL-2048'],
      ['Total TTC', 'CHF 324.30'],
    ],
    result: 'La facture rejoint vos achats.',
    resultBody:
      'Le fournisseur est sélectionné ou créé lorsque les informations sont suffisamment fiables.',
    destination: 'Gestion · Achats & fournisseurs',
    final: 'Prête pour le contrôle comptable',
    condition:
      'Le traitement et la comptabilisation automatiques dépendent de vos règles et des contrôles de la facture. Une information incertaine reste à vérifier.',
  },
  {
    label: 'Un rendez-vous',
    icon: CalendarDays,
    title: 'Un rendez-vous qui trouve sa place.',
    intro: 'La confirmation reçue prépare un événement dans votre agenda.',
    subject: 'Confirmation de notre rendez-vous',
    sender: 'Camille Martin · Contact fictif',
    message:
      'Notre rendez-vous est confirmé le 12 octobre 2026, de 10 h à 11 h, dans nos bureaux à Genève.',
    attachment: 'Confirmation de rendez-vous',
    category: 'Rendez-vous',
    details: [
      ['Date', '12 octobre 2026'],
      ['Horaire', '10:00 – 11:00'],
      ['Lieu', 'Bureaux à Genève'],
    ],
    result: 'Votre agenda est renseigné.',
    resultBody:
      'La date, l’heure et le lieu reconnus accompagnent le rendez-vous dans Gestion.',
    destination: 'Gestion · Agenda',
    final: 'Rendez-vous ajouté',
    condition:
      'L’import doit être activé et les informations du rendez-vous suffisamment complètes. Les dates ambiguës ou les champs manquants restent à contrôler.',
  },
  {
    label: 'Une demande client',
    icon: Users,
    title: 'La bonne demande. La bonne équipe.',
    intro:
      'Automation classe le ticket et l’oriente selon vos règles de support.',
    subject: 'Mon paiement apparaît deux fois',
    sender: 'Alex Morel · Client fictif',
    message:
      'Bonjour, ma commande semble avoir été débitée deux fois. Pouvez-vous vérifier ?',
    attachment: 'Demande de facturation',
    category: 'Facturation',
    details: [
      ['Priorité', 'Élevée'],
      ['Équipe', 'Facturation'],
      ['Action', 'Vérifier le double débit'],
    ],
    result: 'L’équipe concernée prend le relais.',
    resultBody:
      'Les décisions au-dessus du seuil autorisé suivent votre règle de routage. Les autres sont soumises à l’équipe.',
    destination: 'Support · Équipe facturation',
    final: 'Ticket affecté',
    condition:
      'Nécessite une connexion compatible et le routage activé. Aucun remboursement ni paiement bancaire n’est exécuté par Automation.',
  },
] as const;

export function ProductStory({ compact = false }: { compact?: boolean }) {
  const id = useId();
  const [selected, setSelected] = useState(0);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const story = stories[selected];
  useEffect(() => {
    if (!playing) return;
    const stop = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener('visibilitychange', stop);
    const timer = window.setTimeout(() => {
      if (step < 2) setStep(step + 1);
      else setPlaying(false);
    }, 2100);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', stop);
    };
  }, [playing, step]);
  const changeStory = (index: number) => {
    setSelected(index);
    setStep(0);
    setPlaying(false);
  };
  return (
    <div className={`product-story${compact ? ' product-story--compact' : ''}`}>
      <div className="story-selector" aria-label="Choisir un exemple">
        {stories.map(({ label, icon: Icon }, index) => (
          <button
            key={label}
            type="button"
            aria-pressed={selected === index}
            onClick={() => changeStory(index)}
          >
            <Icon size={17} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
      <div className="story-canvas">
        <div className="story-caption">
          <span>Exemple interactif · données fictives</span>
          <span>Support + Gestion + Automation</span>
        </div>
        <div className="story-composition">
          <div className="story-narrative">
            <h2>{story.title}</h2>
            <p>{story.intro}</p>
            <ol className="story-steps" aria-label="Étapes du parcours">
              {[
                'Support reçoit',
                'Automation analyse',
                selected === 2 ? 'Support oriente' : 'Gestion rassemble',
              ].map((label, index) => (
                <li key={label}>
                  <button
                    type="button"
                    aria-pressed={step === index}
                    aria-controls={id}
                    onClick={() => {
                      setStep(index);
                      setPlaying(false);
                    }}
                  >
                    <span className="story-step-number">
                      {step > index ? (
                        <Check size={15} aria-hidden="true" />
                      ) : (
                        index + 1
                      )}
                    </span>
                    <span>{label}</span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
            <button
              className="story-play"
              type="button"
              onClick={() => {
                if (playing) setPlaying(false);
                else {
                  setStep(0);
                  setPlaying(true);
                }
              }}
            >
              {playing ? (
                <Pause size={16} aria-hidden="true" />
              ) : step === 2 ? (
                <RotateCcw size={16} aria-hidden="true" />
              ) : (
                <Play size={16} aria-hidden="true" />
              )}
              {playing
                ? 'Mettre en pause'
                : step === 2
                  ? 'Rejouer le parcours'
                  : 'Animer le parcours'}
            </button>
          </div>
          <div
            className="story-window"
            id={id}
            aria-live="polite"
            aria-atomic="true"
          >
            <div className="story-window-bar">
              <span className="story-wordmark">zentra</span>
              <span>
                {step === 0
                  ? 'Support'
                  : step === 1
                    ? 'Automation'
                    : selected === 2
                      ? 'Support'
                      : 'Gestion'}
              </span>
              <span>Illustration</span>
            </div>
            <div className="story-frame" key={`${selected}-${step}`}>
              {step === 0 ? (
                <>
                  <Mail
                    size={27}
                    className="story-main-icon"
                    aria-hidden="true"
                  />
                  <span className="story-small">Message reçu</span>
                  <h3>{story.subject}</h3>
                  <p className="story-sender">{story.sender}</p>
                  <p className="story-message">{story.message}</p>
                  <div className="story-attachment">
                    <FileText size={18} aria-hidden="true" />
                    {story.attachment}
                  </div>
                </>
              ) : step === 1 ? (
                <>
                  <span className="story-small">Informations reconnues</span>
                  <h3>{story.category}</h3>
                  <dl>
                    {story.details.map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="story-check">
                    <Check size={17} aria-hidden="true" /> Les règles de
                    l’entreprise sont vérifiées.
                  </p>
                </>
              ) : (
                <>
                  <div className="story-result-icon">
                    <Check size={28} aria-hidden="true" />
                  </div>
                  <span className="story-small">{story.destination}</span>
                  <h3>{story.result}</h3>
                  <p className="story-message">{story.resultBody}</p>
                  <p className="story-result-status">
                    <Check size={17} aria-hidden="true" />
                    {story.final}
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
        <p className="story-condition">{story.condition}</p>
      </div>
    </div>
  );
}

export function AutomationBridge({ from }: { from: 'gestion' | 'support' }) {
  return (
    <section className="automation-bridge" aria-labelledby={`bridge-${from}`}>
      <div>
        <h2 id={`bridge-${from}`}>
          {from === 'gestion'
            ? 'Et si vos documents arrivaient déjà préparés ?'
            : 'Un e-mail peut devenir bien plus qu’un ticket.'}
        </h2>
        <p>
          {from === 'gestion'
            ? 'Avec Support relié à votre entreprise, Automation prépare les factures reçues, reconnaît les rendez-vous et réunit les actions à vérifier dans Gestion.'
            : 'Une facture vers les achats. Une confirmation vers l’agenda. Reliez Support à votre entreprise Gestion et activez Automation pour suivre ce parcours.'}
        </p>
        <a href="/automation">
          Découvrir Zentra Automation{' '}
          <ArrowRight size={18} aria-hidden="true" />
        </a>
      </div>
      <div className="bridge-flow">
        <span>
          Support <small>Les messages reçus</small>
        </span>
        <ArrowRight size={21} aria-hidden="true" />
        <span>
          Automation <small>Vos règles appliquées</small>
        </span>
        <ArrowRight size={21} aria-hidden="true" />
        <span>
          Gestion <small>Le suivi de l’entreprise</small>
        </span>
      </div>
      <p className="bridge-note">
        Automation : +15 CHF/mois par entreprise avec Gestion. Support dispose
        de son propre abonnement. Connexions et traitements à activer.
      </p>
    </section>
  );
}
