'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowRight,
  CalendarDays,
  Check,
  FileText,
  Mail,
  Pause,
  Play,
  RotateCcw,
} from 'lucide-react';

const examples = [
  {
    label: 'Une facture',
    sender: 'Atelier Léman',
    subject: 'Votre facture de fournitures',
    message:
      'Bonjour, voici la facture AL-2048 pour votre commande. Bonne journée !',
    document: 'Facture AL-2048.pdf',
    category: 'Facture fournisseur',
    fields: [
      ['Fournisseur', 'Atelier Léman'],
      ['Référence', 'AL-2048'],
      ['Total TTC', 'CHF 324.30'],
    ],
    result: 'La facture est à sa place.',
    destination: 'Gestion · Achats & fournisseurs',
    resultNote:
      'Le fournisseur est retrouvé ou créé. Les informations de la facture sont prêtes pour le contrôle comptable.',
    condition:
      'Support et Gestion doivent être reliés à la même entreprise. L’import et la comptabilisation dépendent de vos règles et des contrôles. Une information incertaine reste à vérifier.',
    title: 'Une facture reçue. La suite se prépare.',
    icon: FileText,
  },
  {
    label: 'Un rendez-vous',
    sender: 'Camille Martin',
    subject: 'Notre rendez-vous est confirmé',
    message:
      'À bientôt dans nos bureaux à Genève, le 12 octobre 2026 de 10 h à 11 h.',
    document: 'Confirmation de rendez-vous',
    category: 'Rendez-vous',
    fields: [
      ['Date', '12 octobre 2026'],
      ['Horaire', '10:00 – 11:00'],
      ['Lieu', 'Bureaux à Genève'],
    ],
    result: 'Votre agenda est renseigné.',
    destination: 'Gestion · Agenda',
    resultNote:
      'La date, l’heure et le lieu accompagnent le rendez-vous. Votre équipe retrouve les mêmes informations.',
    condition:
      'Support et Gestion doivent être reliés à la même entreprise, avec l’import activé. Une date ambiguë ou une information manquante reste à contrôler.',
    title: 'Un rendez-vous reçu. Un agenda à jour.',
    icon: CalendarDays,
  },
  {
    label: 'Une demande client',
    sender: 'Alex Morel',
    subject: 'Mon paiement apparaît deux fois',
    message:
      'Bonjour, ma commande semble avoir été débitée deux fois. Pouvez-vous vérifier ?',
    document: 'Demande de facturation',
    category: 'Facturation',
    fields: [
      ['Catégorie', 'Facturation'],
      ['Priorité', 'Élevée'],
      ['Équipe', 'Facturation'],
    ],
    result: 'La bonne équipe prend le relais.',
    destination: 'Support · Équipe facturation',
    resultNote:
      'Le ticket rejoint l’équipe concernée selon vos règles. Elle dispose du contexte pour répondre.',
    condition:
      'Nécessite une connexion compatible et le routage activé. Seules les décisions au-dessus du seuil autorisé sont routées automatiquement. Aucun remboursement ni paiement bancaire n’est exécuté.',
    title: 'Une demande reçue. La bonne équipe.',
    icon: Mail,
  },
] as const;

export function HomeExperience() {
  const [selected, setSelected] = useState(0);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const panelId = useId();
  const stage = useRef<HTMLDivElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const resultLink = useRef<HTMLAnchorElement>(null);
  const focusResultOnAdvance = useRef(false);
  const example = examples[selected];
  const Icon = example.icon;
  const labels = [
    'Support reçoit',
    'Automation reconnaît',
    selected === 2 ? 'Support oriente' : 'Gestion rassemble',
  ];

  useEffect(() => {
    if (step === 2 && focusResultOnAdvance.current) {
      resultLink.current?.focus({ preventScroll: true });
      focusResultOnAdvance.current = false;
    }
  }, [step]);

  useEffect(() => {
    if (!playing) return;
    const stop = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener('visibilitychange', stop);
    const timer = window.setTimeout(() => {
      if (step < 2) {
        setStep(step + 1);
        if (step === 1) setPlaying(false);
      } else setPlaying(false);
    }, 1900);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', stop);
    };
  }, [playing, step]);

  function start() {
    setStep(0);
    setPlaying(true);
  }

  return (
    <section className="home-experience" aria-labelledby="home-title">
      <div className="experience-intro">
        <h1 id="home-title">
          Votre entreprise.
          <br />
          <span>Un quotidien plus simple.</span>
        </h1>
        <p>
          Gestion, Support et Automation relient vos clients, vos factures et
          vos tâches. Tout avance ensemble. Vous gardez la main.
        </p>
        <div className="experience-actions">
          <button
            className="zentra-primary"
            type="button"
            onClick={() => {
              stage.current?.scrollIntoView({
                behavior: window.matchMedia('(prefers-reduced-motion: reduce)')
                  .matches
                  ? 'instant'
                  : 'smooth',
                block: 'start',
              });
              playButton.current?.focus({ preventScroll: true });
              start();
            }}
          >
            Voir Zentra à l’œuvre <Play size={16} aria-hidden="true" />
          </button>
          <a className="zentra-text-link" href="#choisir">
            Trouver mon outil <ArrowRight size={17} aria-hidden="true" />
          </a>
        </div>
      </div>

      <div className="experience-stage" id="parcours" ref={stage}>
        <fieldset
          className="experience-examples"
          aria-label="Choisir un exemple"
        >
          {examples.map((item, index) => (
            <button
              key={item.label}
              type="button"
              aria-pressed={selected === index}
              aria-controls={panelId}
              onClick={() => {
                setSelected(index);
                setStep(0);
                setPlaying(false);
              }}
            >
              {item.label}
            </button>
          ))}
        </fieldset>
        <div className="experience-workspace">
          <div className="experience-toolbar">
            <span>Essayez. Tout part d’un message.</span>
            <button
              ref={playButton}
              type="button"
              className="experience-play"
              onClick={() =>
                playing
                  ? setPlaying(false)
                  : step === 2
                    ? start()
                    : setPlaying(true)
              }
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
                  ? 'Rejouer'
                  : 'Lancer l’exemple'}
            </button>
          </div>
          <div className="experience-body" id={panelId}>
            <div className="experience-document" data-stage={step}>
              <div className="experience-document-top">
                <Icon size={20} aria-hidden="true" />
                <span>
                  {step === 0
                    ? 'Message reçu'
                    : step === 1
                      ? 'Informations reconnues'
                      : example.destination}
                </span>
                {step === 2 && <Check size={18} aria-hidden="true" />}
              </div>
              <div
                className="experience-document-content"
                key={`${selected}-${step}`}
              >
                {step === 0 ? (
                  <>
                    <p className="experience-sender">{example.sender}</p>
                    <h2>{example.subject}</h2>
                    <p className="experience-message">{example.message}</p>
                    <div className="experience-attachment">
                      <Icon size={19} aria-hidden="true" />
                      {example.document}
                    </div>
                  </>
                ) : (
                  <>
                    <h2>
                      {step === 1
                        ? example.category
                        : selected === 0
                          ? 'Facture AL-2048'
                          : selected === 1
                            ? 'Rendez-vous avec Camille'
                            : 'Vérifier le double débit'}
                    </h2>
                    <dl>
                      {example.fields.map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="experience-document-status">
                      <Check size={16} aria-hidden="true" />
                      {step === 1
                        ? 'Informations rassemblées'
                        : selected === 0
                          ? 'Prête pour le contrôle comptable'
                          : selected === 1
                            ? 'Ajouté à l’agenda'
                            : 'Affecté à l’équipe facturation'}
                    </p>
                  </>
                )}
              </div>
            </div>
            <div className="experience-explanation">
              <h2>
                {step === 0
                  ? example.title
                  : step === 1
                    ? 'Les détails utiles. Sans tout ressaisir.'
                    : example.result}
              </h2>
              <p>
                {step === 0
                  ? 'Support rassemble vos messages dans un espace commun. Choisissez un exemple et regardez la suite.'
                  : step === 1
                    ? 'Automation reconnaît le document et extrait ses informations. Vos règles déterminent la prochaine action.'
                    : example.resultNote}
              </p>
              {step === 2 ? (
                <a ref={resultLink} href="/automation" className="zentra-text-link">
                  Découvrir Automation{' '}
                  <ArrowRight size={17} aria-hidden="true" />
                </a>
              ) : (
                <button
                  className="experience-next"
                  type="button"
                  onClick={() => {
                    focusResultOnAdvance.current = step === 1;
                    setStep(step + 1);
                    setPlaying(false);
                  }}
                >
                  Voir la suite <ArrowRight size={17} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
          <ol
            className="experience-progress"
            aria-label="Les étapes du parcours"
          >
            {labels.map((label, index) => (
              <li key={label} data-complete={step >= index}>
                <button
                  type="button"
                  aria-pressed={step === index}
                  aria-controls={panelId}
                  onClick={() => {
                    setStep(index);
                    setPlaying(false);
                  }}
                >
                  <span>
                    {step > index ? (
                      <Check size={14} aria-hidden="true" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  {label}
                </button>
              </li>
            ))}
          </ol>
        </div>
        <div className="experience-caption">
          <span>Exemple interactif · données fictives</span>
          <details key={selected}>
            <summary>Comment cela fonctionne</summary>
            <p>{example.condition}</p>
          </details>
        </div>
        <output className="sr-only">
          {labels[step]}. {step === 2 ? example.result : ''}
        </output>
      </div>
    </section>
  );
}

const choices = [
  {
    label: 'Gérer mon entreprise',
    name: 'Zentra Gestion',
    title: 'Votre activité, au même endroit.',
    text: 'Devis, factures, projets, achats et comptabilité : retrouvez les informations dont vous avez besoin au quotidien.',
    price: 'Dès 49 CHF / mois',
    note: 'Choisissez une formule pour 1, 3 ou 10 personnes.',
    href: '/gestion',
    demo: '/demo-facture',
    action: 'Visiter l’app',
  },
  {
    label: 'Organiser mes demandes clients',
    name: 'Zentra Support',
    title: 'Chaque demande trouve sa place.',
    text: 'Rassemblez vos messages et tickets dans un espace dédié. Votre équipe sait ce qui arrive et qui s’en occupe.',
    price: 'Dès 29 CHF / mois',
    note: 'Disponible séparément de Gestion.',
    href: '/support',
    demo: '/support/demo',
    action: 'Essayer la démo',
  },
  {
    label: 'Automatiser mon quotidien',
    name: 'Zentra Automation',
    title: 'Les petites tâches avancent.',
    text: 'Factures reconnues, fournisseurs retrouvés, rendez-vous préparés : Automation accompagne le travail de votre entreprise.',
    price: '15 CHF / mois par entreprise',
    note: 'Option de Gestion. Les parcours e-mail nécessitent aussi Support.',
    href: '/automation',
    demo: '/automation#utilisation',
    action: 'Voir comment l’activer',
  },
  {
    label: 'Tout réunir',
    name: 'Zentra Complet',
    title: 'Trois produits. Un seul abonnement.',
    text: 'Gestion, Support et Automation réunis pour votre entreprise et ses collaborateurs, avec un quota d’analyses défini.',
    price: 'Dès 79 CHF / mois',
    note: 'Essai de 14 jours : 3 personnes et 250 analyses, sans carte bancaire.',
    href: '/complet',
    demo: '/complet#formules',
    action: 'Découvrir les formules',
  },
] as const;

export function ProductFinder() {
  const [selected, setSelected] = useState(0);
  const id = useId();
  const choice = choices[selected];
  return (
    <section
      className="product-finder"
      id="choisir"
      aria-labelledby="finder-title"
    >
      <div className="finder-heading">
        <h2 id="finder-title">
          Commencez par
          <br />
          <span>ce qui compte pour vous.</span>
        </h2>
        <p>
          Un besoin aujourd’hui. D’autres demain.
          <br />
          Votre espace peut évoluer avec vous.
        </p>
      </div>
      <div className="finder-layout">
        <fieldset className="finder-options" aria-label="Votre besoin">
          {choices.map((item, index) => (
            <button
              type="button"
              key={item.name}
              aria-pressed={selected === index}
              aria-controls={id}
              onClick={() => setSelected(index)}
            >
              <span>{item.label}</span>
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          ))}
        </fieldset>
        <div
          className="finder-result"
          id={id}
          aria-live="polite"
          aria-atomic="true"
        >
          <div key={selected}>
            <h3>{choice.name}</h3>
            <p className="finder-product">{choice.title}</p>
            <p>{choice.text}</p>
            <p className="finder-price">{choice.price}</p>
            <div className="finder-actions">
              <a className="zentra-primary" href={choice.demo}>
                {choice.action}
                <ArrowRight size={16} aria-hidden="true" />
              </a>
              <a className="zentra-text-link" href={choice.href}>
                En savoir plus
              </a>
            </div>
            <p className="finder-note">{choice.note}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
