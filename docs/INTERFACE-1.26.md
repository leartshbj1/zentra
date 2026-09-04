# Interface Zentra 1.26

Cette version harmonise les écrans de l’application native Windows, macOS, iOS et Android.

- Texte courant et commandes plus lisibles, surfaces plus sobres, contraste renforcé, moins d’animations décoratives.
- Recherche dans les listes disponible aussi sur téléphone. Le bouton de recherche d’écran et Ctrl/⌘ K donnent accès aux modules ; flèches, Entrée et Échap sont pris en charge.
- Premiers pas repliables avec la prochaine action toujours accessible. La progression reste fondée sur les données enregistrées.
- Projets filtrables par état et par client, noms longs lisibles, ouverture du dossier depuis le nom du projet et depuis le tableau de bord.
- Paramètres répartis en sept rubriques. Fermer une rubrique conserve ses champs montés et leur saisie ; les raccourcis ouvrent la rubrique du réglage demandé.
- Dialogues rendus dans un portail au niveau du document pour éviter les découpages par les cartes et les conteneurs défilants.
- Sur mobile, seules les tables modifiées sont réétiquetées ; le chronomètre et les autres changements de texte ne relancent plus une analyse de toute la page.

Les formats des documents imprimés, les règles financières et les formats de stockage restent gérés par leurs modules existants. Aucune bibliothèque de production n’a été ajoutée.

## Recette reproductible

`pnpm --dir desktop test:ui` et `pnpm --dir desktop build:web` couvrent les tests existants et la compilation.

La recette visuelle utilise le vrai composant WorkspaceApp avec un bridge de test en mémoire, dans `desktop/tests/mobile-harness.tsx`. Elle ne manipule pas la base de l’utilisateur. Démarrer le serveur :

```sh
pnpm --dir desktop exec vite --config tests/vite.config.ts --host 127.0.0.1 --port 5175 --strictPort
```

Puis lancer `node desktop/tests/workspace-journey.mjs`. Playwright doit être disponible pour la recette ; `ZENTRA_PLAYWRIGHT_MODULE` permet d’indiquer son installation existante et `ZENTRA_QA_URL` de changer le serveur. Sur Windows le script utilise Edge ; sur les autres systèmes il utilise Chromium de Playwright.

Le parcours crée un projet avec pièce jointe, un devis et une facture dans le même dossier, vérifie les filtres, les paramètres repliables et la conservation de leur saisie, puis visite 16 modules et sept rubriques aux largeurs 320, 390, 768, 1024 et 1440. Le rapport et les captures sont écrits dans `.qa/design/`. Une erreur JavaScript ou un débordement horizontal de la page fait échouer la recette. Les tableaux volontairement défilants restent dans leur conteneur.

Cette recette de présentation ne remplace pas les tests du moteur Rust ni les essais de signature et de démarrage natifs. La diffusion par les stores mobiles dépend toujours des comptes et signatures Apple et Google.
