# Pilote navigateur US — coordonnées du vendeur

Base : `3328a3c394541b22f1e6a0977d7b0f16547956b9`. Livraison locale additive, dans la copie internationale isolée. Le site commercial publié reste la version354 ; les distributions natives et les flags de production ne sont pas modifiés.

## Modifications

Le propriétaire renseigne le nom du vendeur, son e-mail et son téléphone dans le même espace de travail que les clients et devis US. Ce réglage est disponible avant l'initialisation comptable. Les autres rôles voient uniquement les coordonnées sauvegardées. Aucun champ de rôle, de souscription, d'EIN, de secret ou de compte fiscal n'est fourni par le formulaire.

Le transport navigateur est distinct du transport ERP : ses révisions et UUID ne sont pas les révisions et clés des devis. Il exige une lecture initiale, garde une seule demande immuable en mémoire et reprend exactement cette demande si le résultat est incertain. Après un reçu, y compris un ancien reçu rejoué, le panneau relit le profil courant ; le reçu ne remplace jamais le head. Seuls les conflits explicitement refusés imposent une nouvelle lecture puis une nouvelle confirmation. Il n'y a ni autosave, ni nouvelle requête automatique avec une nouvelle clé.

Les canaux vendeur et ERP partagent l'invalidation de l'accès, le verrou des nouvelles modifications et le masquage des données. Un changement Auth ou un refus401/402/403 vide les brouillons visibles et masque aussi les réponses retardées de l'autre canal. Les transports refusent dès les headers HTTP sans attendre un corps d'erreur bloqué ; une réponse de sauvegarde déjà autorisée puis retardée ne libère pas une demande à reprendre après un refus observé. Une lecture réussie ne prouve pas le rôle propriétaire : après invalidation, les nouvelles modifications exigent un rendu serveur frais. La reprise exacte reste contrôlée par le serveur.

Les détails suivent les styles existants de Zentra : labels distincts des contacts clients, champs et commandes tactiles, état vide explicite, clair/sombre et quatre langues. Les textes de limitation indiquent que les coordonnées peuvent être enregistrées, alors que le moteur fiscal, l'émission de factures et les paiements US restent indisponibles.

## Fichiers

Créés : `components/account/us-seller-profile-panel.tsx`, `lib/international/browser-seller-session.ts`, `browser-seller-session.test.ts`, `browser-seller-panel.test.ts`, ce rapport et `docs/evidence/us-seller-browser-20261008.json`.

Modifiés : `components/account/us-erp-workbench.tsx` et son CSS, `lib/international/browser-workbench-copy.ts`, `browser-workbench.browser.test.ts`, `browser-erp-session.ts`, `browser-erp-session.test.ts`, ainsi que l'extraction des deux validateurs publics purs dans `seller-profile.ts`. Les services HTTP conservent leurs validations et autorisations serveur.

## Migration et retour arrière

Aucune nouvelle migration dans ce lot. La migration vendeur du lot précédent reste uniquement appliquée aux bases fictives locales. Aucune migration existante n'est réécrite, aucune donnée ou région n'est déplacée et aucun prix USD n'est créé. Les flags fermés permettent de retirer le parcours pilote sans effacer les coordonnées ni leur historique. L'approbation et la recette staging restent nécessaires avant toute modification de production.

## Vérifications

La sélection finale de quinze fichiers compte **524 tests réussis, zéro échec et zéro ignoré** : transports, helpers et rendu React, services et handlers HTTP, bindings, moteur ERP et SQL/RPC sur PGlite local. Les deux transports comptent120tests dans cette sélection, incluant refus immédiats, réponses retardées, reçus anciens et reprise exacte. Les tests réels de SQL/RPC restent séparés des stores RAM utilisés pour les interactions navigateur.

L'essai navigateur optionnel a été exécuté séparément et réussi :24vues (FR/DE/IT/EN, clair/sombre,320/390/1440px), huit vues à320px avec texte agrandi à200%, aucun débordement horizontal mesuré et aucune erreur de page. Six commits ERP et six commits vendeur dans les stores fictifs ont couvert notamment l'initialisation, l'arrondi USD, les conflits CAS, le reçu perdu après commit, une reprise exacte après une révision plus récente, les restrictions de rôle, la révocation d'accès et les réponses retardées entre les canaux. Une deuxième page partage le store local ; ce n'est pas un essai entre deux comptes Supabase hébergés. Les quatre captures cadrées vendeur ont été inspectées après le gel, sans défaut matériel supplémentaire observé.

Les deux premiers essais navigateur ont échoué dans le harness parce qu'il refermait un `<details>` déjà ouvert puis tentait d'utiliser son formulaire masqué. L'ouverture a été rendue idempotente, les assertions métier conservées, puis le parcours complet relancé. Le rapport détaillé du deuxième échec et les transcriptions disponibles sont conservés séparément ; le premier fichier d'échec a été remplacé lors du deuxième essai. Ces erreurs de harness ne sont ni comptées comme succès ni attribuées à l'application.

TypeScript (`--noEmit --incremental false`), Oxlint des dix fichiers TypeScript/TSX concernés, build Vinext de production et `git diff --check` sont réussis. Les avertissements Vinext de classification statique de routes restent présents. Les hashes des onze sources étaient identiques entre les checks et le gel ; seule une formulation explicative de portée dans le harness a ensuite été corrigée, sans changement d'interaction ou d'assertion. PGlite vérifie les invariants et reprises SQL locaux, sans preuve de durabilité après redémarrage ou crash. Aucune migration SQL suivie n'est modifiée dans ce lot. Les résultats, hashes et correction éditoriale sont consignés dans `docs/evidence/us-seller-browser-20261008.json`.

## Terminé et limites

Ce lot rend les coordonnées vendeur utilisables dans le pilote navigateur US. Il ne vérifie ni l'identité légale de l'entreprise, ni son immatriculation fiscale, ni un abonnement Stripe effectivement payé. Les retries sont conservés seulement en mémoire tant que ce panneau est ouvert : recharger ou quitter la page perd l'enveloppe. Avant une nouvelle opération, il faut relire les données persistées et vérifier le résultat interrompu.

Restent expérimentaux : l'ensemble du pilote US et son admission SaaS. Restent à livrer : le profil fiscal privé et le prestataire sandbox, les transactions fiscales durables, les paiements des factures, les autres modules de gestion US, les parcours natifs et la recette à deux sessions Auth/D1/PostgreSQL. Les tests locaux ne prouvent pas une capacité commerciale multi-appareils, une conformité US GAAP ou une validation fiscale des États.
