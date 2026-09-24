'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Expand,
  Laptop,
  Smartphone,
  X,
} from 'lucide-react';
import {
  appTourScreens,
  tourGroups,
  tourImage,
  type TourDevice,
} from '@/lib/app-tour';
import './app-tour.css';

const phoneQuery = '(max-width: 760px)';
function subscribePhone(callback: () => void) {
  const query = window.matchMedia(phoneQuery);
  query.addEventListener('change', callback);
  return () => query.removeEventListener('change', callback);
}

export function AppTour() {
  const [index, setIndex] = useState(0);
  const [device, setDevice] = useState<TourDevice | 'auto'>('auto');
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [retry, setRetry] = useState(0);
  const phone = useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(phoneQuery).matches,
    () => false,
  );
  const actualDevice =
    device === 'auto' ? (phone ? 'mobile' : 'desktop') : device;
  const screen = appTourScreens[index];
  const imageKey = `${screen.id}-${actualDevice}`;
  const failed = failedFor === imageKey;
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const read = () => {
      const found = appTourScreens.findIndex(
        (item) => `#${item.id}` === location.hash,
      );
      setIndex(found >= 0 ? found : 0);
      setFailedFor(null);
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  function select(next: number) {
    if (next < 0 || next >= appTourScreens.length) return;
    setIndex(next);
    setFailedFor(null);
    history.replaceState(null, '', `#${appTourScreens[next].id}`);
  }
  function step(next: number) {
    select(next);
    content.current?.scrollIntoView({
      block: 'start',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
  }
  const imagePath = (mode: TourDevice) =>
    tourImage(screen.id, mode) + (retry ? `?retry=${retry}` : '');
  function picture(inDialog = false) {
    return (
      <picture>
        {device === 'auto' && (
          <source media={phoneQuery} srcSet={imagePath('mobile')} />
        )}
        <img
          key={`${screen.id}-${device}-${retry}-${inDialog}`}
          src={imagePath(device === 'auto' ? 'desktop' : device)}
          width={device === 'mobile' ? 390 : 1440}
          height={device === 'mobile' ? 844 : 960}
          alt={`Zentra Gestion — ${screen.label}, entreprise fictive Atelier du Léman`}
          onError={() => setFailedFor(imageKey)}
          draggable={false}
          decoding="async"
        />
      </picture>
    );
  }
  return (
    <section
      className="app-tour"
      aria-label="Visite visuelle de Zentra Gestion"
    >
      <div className="tour-mobile-menu">
        <label htmlFor="tour-screen">Explorer l’app</label>
        <div>
          <select
            id="tour-screen"
            value={index}
            onChange={(event) => select(Number(event.target.value))}
          >
            {tourGroups.map((group, groupIndex) => (
              <optgroup key={group} label={group}>
                {appTourScreens.map(
                  (item, i) =>
                    item.group === groupIndex && (
                      <option key={item.id} value={i}>
                        {item.label}
                      </option>
                    ),
                )}
              </optgroup>
            ))}
          </select>
          <ChevronDown size={18} aria-hidden="true" />
        </div>
      </div>
      <nav className="tour-menu" aria-label="Écrans de l’application">
        {tourGroups.map((group, groupIndex) => (
          <div key={group}>
            <p>{group}</p>
            {appTourScreens.map(
              (item, i) =>
                item.group === groupIndex && (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={index === i ? 'page' : undefined}
                    onClick={() => select(i)}
                  >
                    <span>{item.label}</span>
                    {index === i && <Check size={15} aria-hidden="true" />}
                  </button>
                ),
            )}
          </div>
        ))}
      </nav>
      <div className="tour-content" ref={content}>
        <div className="tour-toolbar">
          <span>
            Atelier du Léman{' '}
            <span className="tour-fiction">· entreprise fictive</span>
          </span>
          <fieldset aria-label="Format de l’aperçu">
            <button
              type="button"
              aria-label="Voir sur ordinateur"
              aria-pressed={actualDevice === 'desktop'}
              onClick={() => setDevice('desktop')}
            >
              <Laptop size={18} />
              <span>Ordinateur</span>
            </button>
            <button
              type="button"
              aria-label="Voir sur mobile"
              aria-pressed={actualDevice === 'mobile'}
              onClick={() => setDevice('mobile')}
            >
              <Smartphone size={17} />
              <span>Mobile</span>
            </button>
          </fieldset>
        </div>
        <figure className={`tour-screen tour-screen--${actualDevice}`}>
          {failed ? (
            <div className="tour-image-error" role="alert">
              <p>L’aperçu n’a pas pu se charger.</p>
              <button
                type="button"
                onClick={() => {
                  setFailedFor(null);
                  setRetry(retry + 1);
                }}
              >
                Réessayer
              </button>
            </div>
          ) : (
            <button
              className="tour-image-button"
              type="button"
              aria-label={`Agrandir l’écran ${screen.label}`}
              onClick={() => {
                setExpanded(true);
                dialog.current?.showModal();
              }}
            >
              {picture()}
              <span className="tour-expand">
                <Expand size={16} aria-hidden="true" /> Agrandir
              </span>
            </button>
          )}
          <figcaption>
            Vrais écrans de Zentra · données de démonstration
          </figcaption>
        </figure>
        <div className="tour-explanation" aria-live="polite" aria-atomic="true">
          <h2>{screen.title}</h2>
          <p>{screen.description}</p>
          <details key={screen.id}>
            <summary>
              Le détail utile <ChevronDown size={16} aria-hidden="true" />
            </summary>
            <p>{screen.detail}</p>
          </details>
        </div>
        <div className="tour-pagination">
          <button
            type="button"
            disabled={index === 0}
            onClick={() => step(index - 1)}
          >
            <ArrowLeft size={17} />
            <span>Précédent</span>
          </button>
          <span aria-label={`Écran ${index + 1} sur ${appTourScreens.length}`}>
            {index + 1} / {appTourScreens.length}
          </span>
          <button
            type="button"
            disabled={index === appTourScreens.length - 1}
            onClick={() => step(index + 1)}
          >
            <span>Suivant</span>
            <ArrowRight size={17} />
          </button>
        </div>
      </div>
      <dialog
        ref={dialog}
        className={`tour-lightbox tour-lightbox--${actualDevice}`}
        aria-labelledby="tour-lightbox-title"
        onClose={() => setExpanded(false)}
      >
        <div className="tour-lightbox-heading">
          <h2 id="tour-lightbox-title">{screen.label}</h2>
          <button
            type="button"
            autoFocus
            aria-label="Fermer l’aperçu"
            onClick={() => dialog.current?.close()}
          >
            <X size={22} />
          </button>
        </div>
        <div className="tour-lightbox-image">{expanded && picture(true)}</div>
        <p>Atelier du Léman · entreprise fictive</p>
      </dialog>
    </section>
  );
}
