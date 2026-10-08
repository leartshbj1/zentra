# Zentra US — formulaire fiscal privé dans le parcours ERP

Base locale : `f4c4ef31d8300b6881746f0648f9725f3027d62b`. Ce lot complète l'écran ERP US existant ; il ne crée pas une seconde application. Il ne publie aucun changement de production et ne remplace pas la version 354 du site commercial.

## Comportement livré

Le propriétaire retrouve une section fiscale repliée par défaut, disponible en français, allemand, italien et anglais, en thèmes clair et sombre. Le formulaire déclare le nom légal, l'adresse d'origine américaine, l'état ou district, le ZIP et le fuseau horaire. Il utilise le validateur du service privé existant. Il n'infère ni nexus, ni registration, ni exemption à partir de ces champs.

L'état reste « déclaré, non vérifié ». Enregistrer n'active pas l'émission des factures. Les coordonnées publiques du vendeur, les déclarations privées et la comptabilité restent des contrats séparés, dans le même espace de travail.

Les autres rôles ne créent pas de session de lecture fiscale. Le rôle initial de la page n'accorde aucune autorité : la route privée revalide le propriétaire et les droits de l'espace. Le premier GET privé attend l'admission du parcours ERP public. Les relectures et mutations partagent des gardes d'occupation avec ERP et vendeur ; une demande privée incertaine bloque les autres nouvelles modifications.

## Reprise et confidentialité

Le transport fixe l'organisation et l'utilisateur attendu lors de sa création. Ce dernier est une garde contre les réponses d'un ancien compte, jamais un moyen d'authentification. Les appels restent same-origin, avec cookies, sans cache et sans redirection. Le rôle et les droits ne sont pas envoyés dans le JSON.

Après une erreur réseau ou une réponse indéterminée, une action explicite permet de reprendre la demande : nouveau GET propriétaire, puis même corps PUT et même UUID. Un head plus récent ne réécrit jamais la demande en attente. Seuls les conflits SQL connus libèrent cette demande et exigent une relecture avant une nouvelle confirmation. Un enregistrement confirmé est suivi d'une relecture du head actuel ; un échec de cette relecture n'est pas présenté comme un échec de l'enregistrement.

Les refus 401/402/403 purgent la demande en RAM avant de lire le corps de réponse. Déconnexion, changement de compte/espace/rôle, refus sur un canal frère ou fermeture invalident les données privées, le brouillon et les réponses tardives. Aucun stockage persistant privé n'est ajouté au navigateur. La fermeture de la page fait perdre la demande non confirmée : il faut relire le résultat enregistré et le vérifier, sans reconstruire automatiquement un nouveau UUID.

La limite des requêtes est de 30 secondes. Les erreurs présentées utilisent des messages traduits et des codes contrôlés ; elles ne recopient pas de contenu privé ou d'erreur brute du service.

## Tests et preuves

Le QA visuel couvre 32 vues : quatre langues, deux thèmes et les cas 320 px, 320 px avec texte à 200 %, 390 px et 1280 px. Le viewport demeure à 320 px pendant l'agrandissement réel du texte racine (32 px mesurés). Aucun débordement horizontal ; commandes de 45,75 px minimum, et de 59 px minimum avec le texte agrandi. Les listes État et Fuseau ont un label séparé avec `htmlFor` ; leurs noms exacts, leurs IDs et la sélection clavier sont vérifiés dans chaque vue. Le premier échec `getByLabel` provenait de la concaténation des options dans un label englobant ; l'arbre accessible avait déjà le bon nom. La correction clarifie le markup, sans prétendre corriger une absence de nom accessible démontrée.

Le parcours supplémentaire utilise le vrai composant React, le transport privé, les handlers HTTP, les services et les RPC PostgreSQL existants. Les lectures ERP/vendeur/delta utilisent aussi les vrais handlers et RPC. Auth/D1, flags et réseau restent des fixtures locales. Les déclarations fictives passent depuis le formulaire jusqu'au head et à l'audit ; une seconde modification est réellement enregistrée puis son JSON HTTP200 est volontairement tronqué pour simuler un reçu incomplet. Le bouton reprend GET propriétaire → PUT avec même corps et UUID → GET courant. Le head reste à la révision 2 et l'historique à deux lignes, avec reçu exact marqué `replayed`.

Douze lectures publiques ERP, delta, révision et vendeur ne contiennent pas les faits privés. Un vrai refus propriétaire HTTP403 purge le DOM et le brouillon ; un GET public ensuite admis pour le membre ne rouvre pas le panneau de l'ancien propriétaire. Le resolver reste bloqué et aucun journal ou facture n'est émis.

Un premier essai avec fermeture du socket avant les headers a provoqué une reprise HTTP automatique de Chromium, puis un timeout du test qui attendait le bouton manuel. Ce n'était pas un défaut utilisateur établi. Cette observation locale conserve seulement deux PUT de même empreinte et un GET ; elle ne mesure pas un nouveau snapshot SQL après cette tentative interrompue. La preuve finale utilise la troncature déterministe après commit et mesure directement head, audit et reçu. Elle ne revendique pas un crash réseau réel.

La régression finale sur les sources gelées comprend **1 978 tests réussis, aucun échec ni test ignoré, 57 fichiers**. Elle reprend les 53 fichiers internationaux et consommateurs CH ciblés du lot précédent, ajoute les quatre fichiers du navigateur fiscal, active PostgreSQL local et les trois QA navigateur. Les 83 tests de transport et dix tests de formulaire sont compris dans ce total. Les trois parcours navigateur réussissent : ERP/vendeur public, interface fiscale privée et interface fiscale → handlers → PostgreSQL. TypeScript global, Oxlint sur les dix fichiers TypeScript créés/modifiés, build Vinext et `git diff --check` passent. Les 132 fichiers SQL suivis à la base sont inchangés. Le build conserve son avertissement connu de classification statique de certaines routes ; il ne vérifie pas les sessions hébergées.

Résultats, périmètre et empreintes dans [la preuve consolidée](../evidence/us-tax-profile-browser-20261008.json) et [la preuve visuelle](../evidence/us-tax-profile-ui-20261008.json). Logs locaux sous `.qa/us-tax-profile-browser/`, `.qa/us-tax-browser/`, `.qa/us-seller-browser/` et `.qa/us-tax-postgres-browser/`. Quatre captures finales ont été inspectées visuellement, notamment mobile, sombre et texte agrandi ; cette inspection complète les mesures, sans certifier tous les écrans de l'application.

Les preuves UI et PostgreSQL distinguent le navigateur réel, les handlers et le service réels, les RPC locaux, et l'autorité Auth/D1 synthétique. PGlite est une seule instance PostgreSQL sérialisée en RAM. Aucun essai local n'est une preuve de production, de PostgREST hébergé, de durabilité après redémarrage ou de concurrence entre deux connexions PostgreSQL hébergées. Les consommateurs CH ciblés ne remplacent pas une recette de toutes les distributions natives, des QR-factures sur appareil, des paiements et de la collaboration hébergée.

## Migration et retour arrière

Aucune migration nouvelle dans ce lot. Il consomme les RPC proposées par `20261008044402_international_us_tax_profile.sql`, validées localement dans le lot précédent. Aucune migration ancienne, donnée client, région, licence CHF, QR-facture CH ou distribution native n'est modifiée.

Retour arrière : retirer les branchements du panneau et conserver les flags US fermés ; garder les déclarations et leur audit. Aucun effacement ou downgrade destructif n'est proposé.

## Prestataire fiscal et état des essais Stripe

L'accès Stripe MCP disponible ne présente que le compte réel. Aucun paramètre Tax, registration, prix, paiement ou abonnement de ce compte n'a été changé. Les recherches Stripe Directory avec le CLI officiel actuel ont été refusées par leur service ; ce refus n'est pas un résultat de comparaison entre fournisseurs.

Une sandbox anonyme temporaire a été créée, mais sa clé de TEST est apparue dans la sortie de création de l'outil. Elle a été abandonnée sans données métier, registration ou calcul fiscal. Le profil local a été déconnecté. Cette commande efface l'accès local et ne révoque pas cette catégorie de clé côté Stripe ; ne pas la présenter comme une révocation distante. La sandbox temporaire doit expirer le 15 octobre 2026. Aucune valeur secrète ni URL de prise de possession n'est enregistrée dans le repository ou ce rapport.

Les tentatives suivantes ont demandé une connexion navigateur plutôt que fournir une sandbox authentifiée ; un exit 0 de la commande ne constitue donc pas une provision réussie. Une sandbox « Zentra US » contrôlée par le titulaire est demandée et son accès reste à établir. Aucun calcul Stripe Tax réel ni preuve d'émission n'est revendiqué.

La tentative d'inventaire des onglets pour terminer cet accès a échoué avant toute interaction navigateur : `failed to write kernel assets ... (os error 3)`. Une réinitialisation du noyau suivie d'un nouvel inventaire a retourné la même erreur. Aucun onglet Stripe n'a donc été lu ou modifié dans cette tentative. C'est une limite de l'outil de navigation, pas un diagnostic d'une panne de Zentra ou du compte Stripe.

## Fichiers et suite

Créés :

- `components/account/us-tax-profile-panel.tsx`.
- `lib/international/browser-tax-profile-copy.ts` et `browser-tax-profile-session.ts`.
- `lib/international/browser-tax-profile-session.test.ts`, `browser-tax-profile-panel.test.ts`, `browser-tax-profile.browser.test.ts`, `browser-tax-profile-postgres.browser.test.ts`.
- Ce rapport, `docs/evidence/us-tax-profile-ui-20261008.json` et `docs/evidence/us-tax-profile-browser-20261008.json`.

Modifiés : `components/account/us-erp-workbench.tsx` et `.css`, garde de relecture du vendeur dans `us-seller-profile-panel.tsx`, scénario navigateur public adapté à la sérialisation des relectures. La purge au refus ERP reste vérifiée ; ce scénario ne prétend plus provoquer un refus ERP simultanément à un GET vendeur retenu par cette garde.

Terminé : déclaration privée dans le vrai parcours ERP, garde propriétaire, reprises exactes et présentation multilingue. Expérimental : toute l'édition US reste derrière les flags et une recette staging préalable.

La prochaine tranche doit relier un devis accepté à une opération durable d'émission TEST, un calcul réel et un commit ERP contenant facture, numéro, journal et référence privée à la preuve dans la même transaction. Les révisions persistées pays/vendeur/déclarations/liaison doivent être revalidées sous verrou ; l'ancienne voie RPC ne doit pas contourner cette preuve. Transactions fiscales, paiements, corrections, recettes staging et déploiement restent distincts de cette déclaration. Voir [contrat fiscal proposé](US-TAX-PROVIDER-CONTRACT-20261008.md).
