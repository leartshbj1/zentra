import { ArrowDownToLine, ChevronDown, Laptop, Monitor } from 'lucide-react';
import {
  DownloadButton,
  MacDownloadButton,
} from '@/components/download-button';
import { SiteHeader } from '@/components/site-header';
import {
  ZENTRA_ANDROID_PREVIEW_PATH,
  ZENTRA_ANDROID_VERSION,
  ZENTRA_GITHUB_RELEASE_PATH,
  ZENTRA_IPHONE_IPA_PATH,
  ZENTRA_IPHONE_VERSION,
  ZENTRA_MAC_VERSION,
  ZENTRA_WINDOWS_VERSION,
} from '@/lib/downloads';
import './download.css';

export const metadata = {
  title: 'Télécharger Zentra pour Windows et Mac',
  description:
    'Téléchargez Zentra pour Windows ou Mac. Retrouvez un guide court pour l’installation et les fichiers pour iPhone et Android.',
  alternates: { canonical: '/download' },
};

export default function DownloadPage() {
  return (
    <>
      <a href="#contenu" className="site-skip-link">
        Aller au contenu
      </a>
      <SiteHeader />
      <main id="contenu" tabIndex={-1} className="simple-download">
        <header className="download-intro">
          <h1>Télécharger Zentra.</h1>
          <p>Votre entreprise vous attend.</p>
        </header>
        <section
          className="download-desktop"
          aria-label="Applications pour ordinateur"
        >
          <article
            className="download-platform"
            aria-labelledby="windows-title"
          >
            <Monitor size={42} strokeWidth={1.3} aria-hidden="true" />
            <h2 id="windows-title">Windows</h2>
            <p className="download-requirements">Windows 10 / 11 · 64 bits</p>
            <DownloadButton compact className="download-primary" />
            <p className="download-instruction">
              Ouvrez le fichier, puis suivez l’installation.
            </p>
            <p className="download-version">
              Version {ZENTRA_WINDOWS_VERSION} · Accès anticipé
            </p>
            <details className="download-help">
              <summary>
                Installation bloquée ?{' '}
                <ChevronDown size={17} aria-hidden="true" />
              </summary>
              <div className="download-help-content">
                <h3>Windows affiche un avertissement</h3>
                <p>Pour le fichier Zentra téléchargé depuis cette page :</p>
                <ol>
                  <li>
                    Ouvrez le fichier dans votre dossier{' '}
                    <strong>Téléchargements</strong>.
                  </li>
                  <li>
                    Si SmartScreen affiche « Windows a protégé votre ordinateur
                    », choisissez <strong>Informations complémentaires</strong>,
                    puis <strong>Exécuter quand même</strong>.
                  </li>
                  <li>
                    Suivez l’assistant, puis ouvrez Zentra depuis le menu
                    Démarrer.
                  </li>
                </ol>
                <p>
                  Si cette option n’existe pas, contactez votre administrateur
                  ou{' '}
                  <a href="mailto:info@zentraapp.ch?subject=Installation%20Windows">
                    notre assistance
                  </a>
                  . Gardez vos protections activées.
                </p>
                <a
                  className="download-guide-source"
                  href="https://learn.microsoft.com/fr-fr/windows/apps/package-and-deploy/smartscreen-reputation"
                  target="_blank"
                  rel="noreferrer"
                >
                  Aide Microsoft
                </a>
              </div>
            </details>
          </article>
          <article className="download-platform" aria-labelledby="mac-title">
            <Laptop size={42} strokeWidth={1.3} aria-hidden="true" />
            <h2 id="mac-title">Mac</h2>
            <p className="download-requirements">
              macOS 12+ · Intel et Apple Silicon
            </p>
            <MacDownloadButton compact className="download-primary" />
            <p className="download-instruction">
              Ouvrez le fichier et glissez Zentra dans Applications.
            </p>
            <p className="download-version">
              Version {ZENTRA_MAC_VERSION} · Accès anticipé
            </p>
            <details className="download-help">
              <summary>
                Installation bloquée ?{' '}
                <ChevronDown size={17} aria-hidden="true" />
              </summary>
              <div className="download-help-content">
                <h3>Mac empêche la première ouverture</h3>
                <p>
                  Cette version n’est pas encore notarisée par Apple. Pour
                  Zentra téléchargé depuis cette page :
                </p>
                <ol>
                  <li>
                    Glissez Zentra dans <strong>Applications</strong>, puis
                    essayez de l’ouvrir.
                  </li>
                  <li>
                    Ouvrez{' '}
                    <strong>
                      Réglages Système → Confidentialité et sécurité
                    </strong>
                    .
                  </li>
                  <li>
                    Dans la section Sécurité, choisissez{' '}
                    <strong>Ouvrir quand même</strong> pour Zentra, puis
                    confirmez.
                  </li>
                </ol>
                <p>
                  Si le Mac signale un fichier endommagé ou dangereux,{' '}
                  <a href="mailto:info@zentraapp.ch?subject=Installation%20Mac">
                    contactez-nous
                  </a>{' '}
                  avant de continuer.
                </p>
                <a
                  className="download-guide-source"
                  href="https://support.apple.com/fr-fr/102445"
                  target="_blank"
                  rel="noreferrer"
                >
                  Guide Apple illustré
                </a>
              </div>
            </details>
          </article>
        </section>
        <p className="download-account" id="licence">
          Une fois l’app ouverte, connectez votre compte Zentra.{' '}
          <a href="/connexion">Créer un compte ou se connecter</a>
        </p>
        <section
          className="download-mobile"
          id="mobile-previews"
          aria-labelledby="mobile-title"
        >
          <h2 id="mobile-title">Les fichiers mobiles.</h2>
          <div className="download-mobile-row">
            <div>
              <h3>iPhone</h3>
              <p>Fichier IPA à signer · {ZENTRA_IPHONE_VERSION}</p>
            </div>
            <a
              href={ZENTRA_IPHONE_IPA_PATH}
              download
              aria-label="Télécharger le fichier IPA pour iPhone"
            >
              <span>Télécharger l’IPA</span>
              <ArrowDownToLine size={18} aria-hidden="true" />
            </a>
          </div>
          <div className="download-mobile-row">
            <div>
              <h3>Android</h3>
              <p>Fichier APK de test · {ZENTRA_ANDROID_VERSION}</p>
            </div>
            <a
              href={ZENTRA_ANDROID_PREVIEW_PATH}
              download
              aria-label="Télécharger le fichier APK pour Android"
            >
              <span>Télécharger l’APK</span>
              <ArrowDownToLine size={18} aria-hidden="true" />
            </a>
          </div>
          <a
            className="download-release-link"
            href={ZENTRA_GITHUB_RELEASE_PATH}
          >
            Notes de version et autres fichiers
          </a>
        </section>
      </main>
      <footer className="download-footer">
        <span>Zentra</span>
        <nav aria-label="Liens utiles">
          <a href="mailto:info@zentraapp.ch">Besoin d’aide ?</a>
          <a href="/mentions-legales">Mentions légales</a>
          <a href="/confidentialite">Confidentialité</a>
          <a href="/conditions">Conditions</a>
        </nav>
      </footer>
    </>
  );
}
