export function AppFirstPreview() {
  return (
    <figure className="app-first-preview">
      <div className="app-first-image">
        <picture>
          <source media="(max-width: 600px)" srcSet="/tour/gestion/factures-mobile.webp" />
          <img
            src="/tour/gestion/factures-desktop.webp"
            width={1440}
            height={960}
            fetchPriority="high"
            alt="L’écran Factures de Zentra Gestion : client, montant, encaissement et statut réunis."
          />
        </picture>
      </div>
      <figcaption>Capture de Zentra Gestion · entreprise de démonstration</figcaption>
    </figure>
  );
}
