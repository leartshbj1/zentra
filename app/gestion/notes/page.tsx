import type { Metadata } from 'next';
import { SiteHeader } from '@/components/site-header';
import { SiteFooter } from '@/components/site-footer';
import { ProductHero, ProductDetails } from '@/components/quiet-product';

export const metadata: Metadata = {
  title: 'Notes — Votre carnet de terrain dans Zentra Gestion',
  description: 'Mesures, observations et listes à cocher : découvrez le carnet Notes de Zentra Gestion, pensé pour le mobile et relié à vos projets.',
  alternates: { canonical: '/gestion/notes' },
};

export default function NotesPage() {
  return <div className="quiet-site quiet-notes">
    <a href="#contenu" className="site-skip-link">Aller au contenu</a>
    <SiteHeader />
    <main id="contenu" tabIndex={-1}>
      <ProductHero title={<>Une idée sur place.<br /><span>Retrouvée au bureau.</span></>}
        description="Une mesure, une observation, une chose à faire. Notez-la dans Zentra, au moment où elle compte."
        href="#carnet" action="Découvrir les Notes" price="Zentra Gestion" priceHref="/gestion" />
      <section className="quiet-section quiet-width" id="carnet">
        <h2>Un carnet, toujours à portée de main.</h2>
        <p className="quiet-note">Fonction préparée pour la prochaine mise à jour de Zentra Gestion.</p>
      </section>
      <ProductDetails title="Pensé pour le terrain.">
        <details open><summary>Écrire, puis continuer votre journée</summary><p>Le texte s’enregistre automatiquement. Sur le téléphone, un éditeur plein écran laisse toute la place à votre note.</p></details>
        <details><summary>Retrouver une note dans son projet</summary><p>Rattachez la note au projet concerné, ou gardez-la sans projet. Une recherche et l’épinglage permettent de retrouver l’essentiel.</p></details>
        <details><summary>Garder les choses à faire sous la main</summary><p>Ajoutez des cases à cocher pour les mesures à confirmer, le matériel à commander ou les points à vérifier.</p></details>
        <details><summary>Continuer même sans réseau</summary><p>Les notes sont enregistrées sur l’appareil. Dans une entreprise partagée, elles rejoignent la synchronisation lorsque la connexion revient. Si deux collègues modifient la même note, le texte n’est pas écrasé silencieusement.</p></details>
      </ProductDetails>
      <section className="quiet-offer quiet-width"><div><h2>Tout reste dans votre espace.</h2><p>Un carnet intégré à Gestion, sans abonnement Notes supplémentaire.</p></div><a className="quiet-link" href="/gestion">Découvrir Zentra Gestion</a></section>
    </main>
    <SiteFooter />
  </div>;
}
