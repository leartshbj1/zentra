# Protection des scripts du site — 27 septembre 2026

## Changement

Les réponses HTML publiques et privées reçoivent une politique appliquée avec un nonce aléatoire de 128 bits par réponse. `script-src` n’autorise plus `unsafe-inline` ; les gestionnaires d’événements HTML sont interdits. Les protections existantes contre l’encadrement, les objets et les requêtes externes sont conservées. Les styles en ligne restent autorisés pour les composants existants : cela n’autorise pas les scripts en ligne.

Le Worker retire les indications CSP/nonce entrantes avant de déléguer au gestionnaire Vinext. Ce passage est nécessaire avec la version installée : son moteur de rendu lit les en-têtes de la requête originale avant les remplacements du middleware. Un test navigateur a reproduit un décalage entre nonce HTML et nonce de la réponse avec une valeur forgée ; le test passe après le filtrage. Cookies, origine, méthode et corps JSON sont préservés.

Les pages HTML ne sont pas mises en cache, afin d’éviter la réutilisation ou le désaccord des nonces. Les fichiers statiques à empreinte conservent le cache immuable. Les réponses API, OAuth et pièces jointes gardent leurs propres politiques : la règle statique de `next.config.ts` ne les écrase plus. Les réponses RSC et les actions ne sont pas transformées en HTML.

## Preuves

- 51 tests ciblés, TypeScript et compilation de production réussis.
- 34 contrôles de production locale : Chromium bureau et WebKit à 390 px, 16 routes par moteur, dont accueil, produits, téléchargement, connexion, compte, Support, paiement sans session et page inconnue ; scripts légitimes associés au nonce et zéro violation CSP lors du chargement. Le formulaire de connexion bascule effectivement entre connexion et inscription.
- Pour chaque moteur : trois scripts/actions injectés sans autorisation sont bloqués ; le contrôle positif avec le nonce correct fonctionne. Un en-tête forgé ne choisit plus le nonce du HTML. Deux réponses successives ont des nonces distincts. La page d’erreur OAuth garde sa politique restrictive et un fichier statique son cache immuable.
- HTTPS local avec certificat de développement accepté par le navigateur de recette. Aucune suppression de CSP, aucun trafic navigateur externe autorisé, aucun compte créé, aucun paiement, aucun e-mail.
- Preuves : `.qa/csp-enforcement/proof.json`, `tests.log`, `tsc.log`, `build-direct.log` et six captures. Régression reproductible : `scripts/check-page-csp.mjs` ; `ZENTRA_PLAYWRIGHT_MODULE` permet de désigner Playwright et `ZENTRA_CSP_ORIGIN` le serveur local HTTPS. Le script refuse une origine distante.

Le helper de build Sites a rencontré un ancien lanceur pnpm local incompatible avec l’arborescence des dépendances existantes. Le contrôle d’actifs puis le même CLI Vinext ont été exécutés directement, sans changement de dépendance ni de verrou. Le workflow Sites réutilise ce build validé pour l’archive.

## Limites

Ces essais ne valident pas une session réelle, le paiement Stripe ou tous les connecteurs : le service de compte de production reste indisponible au dernier contrôle. Les pages de compte consultées sont anonymes. Le cas OAuth vérifié est sa réponse d’erreur, pas une autorisation réussie. Une politique CSP n’est pas un audit exhaustif des injections, des droits interentreprises ou des fichiers. Le point de sécurité reste à compléter par les parcours authentifiés après rétablissement du service.

Références : [MDN — script-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src) ; [guide CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP). Le comportement exact de Vinext est également vérifié dans ses fichiers installés `server/csp.js`, `app-rsc-handler.js`, `app-page-dispatch.js` et `app-rsc-response-finalizer.js`.
