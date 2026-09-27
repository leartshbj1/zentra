# Sécurité des pages privées — observation

Le site conserve sa CSP bloquante actuelle. Une politique de scripts plus stricte est ajoutée **en observation** sur les navigations HTML privées : connexion, compte, récupération, invitation, appareil, paiement et espaces Support. Elle autorise les scripts du site et les scripts inline munis d’un nonce aléatoire de 128 bits propre à la réponse. Les API, mutations, réponses RSC et pages marketing gardent leur comportement actuel.

Le middleware remplace tout nonce/CSP fourni par le client avant le rendu. Vinext 1.0.0-beta.5 lit la politique dans les en-têtes de requête et applique ce nonce à ses scripts de démarrage. Les réponses privées concernées sont `private, no-store`, pour ne pas partager le nonce entre utilisateurs via un cache. Les cookies et les autres en-têtes de requête restent disponibles au traitement existant.

HSTS est ajouté avec `max-age=86400` (un jour), sans `includeSubDomains` ni preload : cette modification ne change pas les exigences HTTPS des services de messagerie et autres sous-domaines.

## Preuves locales

- 26 tests ciblés : sélection des routes, requêtes HTML/API/RSC, renouvellement du nonce, refus du nonce fourni par le client, navigation canonique.
- TypeScript et build de production passés.
- `scripts/check-csp-observation.mjs` examine le Worker de production local avec Chromium/Edge : `/connexion`, `/mot-de-passe`, `/support/demo` et `/download`, HTTP 200. Les trois pages privées ont respectivement 23, 19 et 20 scripts inline exécutables munis du nonce attendu ; aucun incident CSP ni erreur JavaScript observé. La page publique reste hors de cette observation. Rapport : `outputs/csp-observation/proof.json`.

## Limites et prochaine étape

La politique n’est pas encore bloquante et aucun collecteur de rapports distant n’est configuré. Les violations éventuelles sont observables dans le navigateur ; ce n’est pas un système d’alerte serveur. La CSP bloquante conserve donc encore `unsafe-inline` pendant cette observation.

Avant enforcement, vérifier les parcours authentifiés complets (compte, administration, reset reçu par e-mail, abonnement Stripe test, navigation client et retour paiement), y compris Safari/WebKit. Les essais ci-dessus sont anonymes et ne réalisent ni paiement ni connexion client. Examiner ensuite les violations éventuelles, corriger leurs causes et retirer `unsafe-inline` des pages couvertes dans une livraison distincte. Ne pas conclure à une conformité ou à l’absence de toute faille à partir de ces seuls contrôles.
