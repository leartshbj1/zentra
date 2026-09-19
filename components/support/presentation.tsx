'use client';
import { useState } from 'react';
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  Mail,
  ShieldCheck,
  Users,
} from 'lucide-react';

const examples = [
  {
    tab: 'Facturation',
    initials: 'ML',
    name: 'Marie L.',
    title: 'Mon paiement apparaît deux fois',
    body: 'Bonjour, ma carte a été débitée deux fois pour la même commande. Pouvez-vous vérifier ?',
    category: 'Facturation',
    priority: 'Élevée',
    team: 'Comptabilité',
    human: false,
  },
  {
    tab: 'Bug',
    initials: 'AD',
    name: 'Alex D.',
    title: 'Impossible de me connecter',
    body: 'Depuis ce matin, la connexion affiche une erreur 500. Je ne peux plus accéder à mon espace.',
    category: 'Bug',
    priority: 'Élevée',
    team: 'Support technique',
    human: false,
  },
  {
    tab: 'Cas à vérifier',
    initials: 'SC',
    name: 'Sam C.',
    title: 'Je voudrais parler à un responsable',
    body: 'Je vous ai déjà contactés deux fois. Merci de transmettre ma demande à une personne responsable.',
    category: 'Autre',
    priority: 'Normale',
    team: 'À vérifier par votre équipe',
    human: true,
  },
];
export function RoutingExample() {
  const [index, setIndex] = useState(0),
    ticket = examples[index];
  return (
    <div className="sp-routing-example">
      <div className="sp-example-heading">
        <span>
          <span className="sp-dot" /> LE TRI, EN UN COUP D’ŒIL
        </span>
        <span>Illustration</span>
      </div>
      <div
        className="sp-example-tabs"
        aria-label="Choisir un exemple de routage"
      >
        {examples.map((e, i) => (
          <button
            key={e.tab}
            type="button"
            onClick={() => setIndex(i)}
            aria-pressed={index === i}
          >
            {e.tab}
          </button>
        ))}
      </div>
      <div key={index} className="sp-example-content" aria-live="polite">
        <div className="sp-message-card">
          <div className="sp-person">
            <span>{ticket.initials}</span>
            <div>
              <strong>{ticket.name}</strong>
              <small>Nouveau ticket</small>
            </div>
            <Mail size={18} />
          </div>
          <h3>{ticket.title}</h3>
          <p>{ticket.body}</p>
        </div>
        <div className="sp-connector">
          <ArrowDown size={17} />
        </div>
        <div className="sp-analysis-card">
          <div className="sp-analysis-title">
            <ShieldCheck size={18} />
            <strong>Analyse Zentra</strong>
            <Check size={15} />
          </div>
          <dl>
            <div>
              <dt>Catégorie</dt>
              <dd>{ticket.category}</dd>
            </div>
            <div>
              <dt>Priorité</dt>
              <dd className={ticket.priority === 'Élevée' ? 'sp-priority' : ''}>
                {ticket.priority}
              </dd>
            </div>
          </dl>
        </div>
        <div className="sp-connector">
          <ArrowDown size={17} />
        </div>
        <div className={`sp-destination ${ticket.human ? 'sp-human' : ''}`}>
          <Users size={23} />
          <div>
            <small>
              {ticket.human
                ? 'REGARD HUMAIN NÉCESSAIRE'
                : 'AFFECTATION SELON VOS RÈGLES'}
            </small>
            <strong>{ticket.team}</strong>
          </div>
          <ArrowUpRight size={19} />
        </div>
      </div>
      <p className="sp-example-note">
        Exemples fictifs. Les décisions réelles dépendent de vos tickets et de
        vos règles.
      </p>
    </div>
  );
}
export function TimeEstimator() {
  const [volume, setVolume] = useState(100),
    [seconds, setSeconds] = useState(45),
    [share, setShare] = useState(60);
  const minutes = (volume * seconds * (share / 100)) / 60,
    hours = (minutes * 20) / 60;
  return (
    <div className="sp-estimator">
      <div className="sp-estimator-controls">
        {[
          {
            id: 'ticket-volume',
            label: 'Tickets par jour',
            value: volume,
            min: 10,
            max: 1000,
            step: 10,
            set: setVolume,
            suffix: '',
          },
          {
            id: 'ticket-seconds',
            label: 'Secondes de tri par ticket',
            value: seconds,
            min: 10,
            max: 180,
            step: 5,
            set: setSeconds,
            suffix: ' s',
          },
          {
            id: 'ticket-share',
            label: 'Part affectée automatiquement',
            value: share,
            min: 0,
            max: 100,
            step: 5,
            set: setShare,
            suffix: ' %',
          },
        ].map((field) => (
          <div key={field.id}>
            <label htmlFor={field.id}>
              {field.label}
              <span>
                {field.value}
                {field.suffix}
              </span>
            </label>
            <input
              id={field.id}
              type="range"
              min={field.min}
              max={field.max}
              step={field.step}
              value={field.value}
              onChange={(e) => field.set(Number(e.target.value))}
            />
          </div>
        ))}
      </div>
      <div className="sp-time-result" aria-live="polite">
        <output>
          {Math.round(minutes).toLocaleString('fr-CH')}
          <span>min / jour</span>
        </output>
        <p>de tri potentiellement évité</p>
        <strong>
          ≈ {hours.toLocaleString('fr-CH', { maximumFractionDigits: 1 })} heures
          par mois
        </strong>
      </div>
      <p className="sp-estimate-note">
        Simulation sur 20 jours ouvrés, à partir de vos hypothèses. Hors temps
        de contrôle, corrections et mise en place. Ce n’est pas un résultat
        mesuré.
      </p>
    </div>
  );
}
