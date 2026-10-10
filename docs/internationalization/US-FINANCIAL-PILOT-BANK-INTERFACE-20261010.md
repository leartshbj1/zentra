# Rapprochement bancaire V5 — interface privée, étape 2B

Livraison locale TEST du 10 octobre 2026. L’interface utilise désormais le protocole et la session commune validés en étape 2A. Cette tranche complète les trois derniers fichiers du [plan navigateur](US-FINANCIAL-PILOT-BANK-BROWSER-PLAN-20261010.md), sans ouvrir la gate ni publier un produit US.

## 1. Résumé des modifications

Un onglet bancaire est intégré au même espace financier US : import manuel CSV, lecture des relevés, rapprochement avec les mouvements comptables, approbation humaine, historique, annulation motivée et export complet. L’interface conserve les choix situés sur d’autres pages, montre les totaux exacts et distingue la clôture enregistrée de la comparaison avec le livre courant.

La même session, le même verrou de mutation et le même timer de trois secondes servent les autres modules. Une modification externe conserve le brouillon, retire sa revue et son approbation, puis demande une nouvelle vérification. Une réponse perdue affiche la reprise de la demande initiale ; le rechargement complet exige l’acceptation explicite de la perte de RAM et ne prétend pas annuler un enregistrement serveur.

Implémentation : `279207574cd496fa02db43d24c0faf9abe863e0a`. [Preuve de livraison](../evidence/us-financial-pilot-bank-interface-20261010.json), SHA-256 `a9f2e85a216a0689c7af3ec0b87ec0e7ebf8b3a1635774b611593dc2967a3eea`. Les quatre contrôles finaux portent sur les mêmes **3640 fichiers**, SHA-256 `90f5953b9e871a11ca487d4ed7bea8d9a49f2ae8161d6370933881ad650d54c8`, figés avant le commit du code et ces documents. Leurs empreintes avant/après concordent.

## 2. Fichiers créés

- `components/account/us-financial-pilot-bank.tsx` — import, détails et pagination des lignes/mouvements/groupes, sélection hors page, revue complète, approbation, reprise exacte, avertissement de rechargement, état legacy et export.
- `components/account/us-financial-pilot-bank.css` — composition du panneau, états de focus/disabled, cibles tactiles, tables à défilement local, clair/sombre et adaptation mobile à 760px.

## 3. Fichiers modifiés

- `components/account/us-financial-pilot.tsx` — onglet traduit, montage du panneau avec la session commune et exclusion des demandes bancaires du bouton de reprise générique.

Trois défauts révélés par l’utilisation réelle sont corrigés dans le panneau : les lectures de contexte n’envoient plus le head entier au validateur strict ; une ligne publique de relevé est ramenée à `statementId/origin` avant les lectures ; le motif d’annulation utilise une saisie sur une ligne, conformément au contrat existant qui refuse les caractères de contrôle. La date d’un mouvement dans la revue apparaît sur une ligne séparée du libellé. Le domaine strict n’a pas été assoupli.

## 4. Migrations proposées et retour arrière

Aucune migration nouvelle. Le domaine, le store, les projections, les sept routes, le protocole, le CSV, la persistance et les anciennes preuves restent ceux des étapes précédentes. Aucun schéma hébergé, source CH, abonnement ou Price ID Stripe, région, publication ni distribution native ne change.

Le retour arrière retire ce panneau/raccordement et garde la gate TEST fermée. Il ne supprime pas les relevés ou les opérations déjà enregistrées. La perte de RAM ne démontre ni l’absence ni l’annulation d’un commit serveur.

## 5. Tests exécutés et résultats

| Contrôle | Résultat réel et périmètre |
| --- | --- |
| TypeScript global, sources finales | Sortie 0, sans incremental, 30.1s. |
| Lint typé, deux fichiers TSX finaux | Sortie 0, deny-warnings. |
| Vérification marque / build production | Sorties 0 / 0, build 20.5s ; aucun déploiement. |
| Recette serveur corroborée depuis les 13 snapshots réellement capturés | 33 assertions passées, 0 échouée/incomplète, 1 non observée sur la liste vide avant import. |
| Corroboration complémentaire rechargement / révocation / revue périmée | 12 assertions passées, 0 échouée, dans deux mondes de test réinitialisés distincts de la collection précédente. |
| Deux CSV effectivement présents dans Downloads, copiés et analysés | 24 contrôles passés, 0 échoué ; 13669 octets chacun, mêmes SHA-256. |
| Recette visuelle représentative | FR/DE/IT/EN, clair/sombre, largeurs 320/390/1280/1440 ; absence de débordement horizontal de page sur les vues mesurées. |
| Revue indépendante finale | Aucun défaut bloquant concret trouvé, dans le périmètre privé relu. |
| Index / whitespace | Exactement trois fichiers d’implémentation ; sorties 0. |

Ces contrôles **ne s’additionnent pas** en un total de tests. La régression **6604/6604 dans 203 fichiers** appartient au [socle de l’étape 2A](US-FINANCIAL-PILOT-BANK-BROWSER-20261010.md), arbre `cdb1041e…e214`. Elle n’a pas été réexécutée sur l’arbre UI de cette étape. Les quatre sorties finales `candidate-5` couvrent les trois empreintes finales ; les anciennes tentatives de lint et les candidats intermédiaires sont archivés avec leurs propres sources.

La recette utilise le vrai `UsFinancialPilot`, React StrictMode, la session commune, le kernel V5 mémoire et les vrais handlers dans un serveur loopback. Auth/D1 et la détermination fiscale sont fictifs ; les requêtes source/sidecar sont sérialisées. Elle ne prouve ni admission hébergée, ni PostgreSQL multiconnexion, ni charge, crash ou disponibilité de production.

Parcours réellement effectués : import de 29 lignes ; approbation impossible avant visite de la deuxième page ; rapprochement du paiement après réponse perdue puis reprise sans doublon ; groupe signé +125/−125 net zéro ; sélection de 26 lignes et mouvements à travers deux pages ; clôture ; mouvement de caisse ultérieur qui change la comparaison courante sans réécrire la clôture ; deux clients actualisés automatiquement après un changement B seul ; annulation motivée, HTTP409 simulé après commit puis reprise exacte. Les preuves corroborent aussi un changement F seul non monétaire, sans revendiquer son observation DOM sur deux clients.

Le rechargement explicite d’une demande incertaine est désactivé avant acceptation de l’avertissement. Après rechargement, un seul groupe enregistré et 28 éléments non rapprochés sont relus ; les preuves serveur avant/après sont identiques octet pour octet. Un changement externe B retire la revue approuvée, conserve les deux sélections et impose une nouvelle approbation. Lors d’une révocation pendant un import, le panneau et le fichier/brouillon disparaissent du DOM.

Les vues legacy complétées restent en lecture seule et un legacy en attente bloque l’import pour ce compte. Un fichier UTF8 invalide est rejeté, puis son remplacement valide efface l’erreur. Les deux CSV contiennent 29 lignes, 29 mouvements, trois groupes et 29 relations de chaque côté, sept sections et 169 lignes CSV logiques ; BOM/UTF8 strict/CRLF, Unicode, espaces significatifs et neutralisation d’une formule sont corroborés par parsing indépendant et roundtrip exact.

Deux attentes automatisées `waitForEvent(download)` ont expiré sur les téléchargements blob : elles ne sont pas annoncées réussies. Les deux fichiers effectivement enregistrés ont ensuite été vérifiés séparément. L’outil de remplissage des dates natives a nécessité des touches fléchées pour déclencher l’événement React ; aucun défaut du champ utilisateur n’en est déduit. L’analyse CSV conserve son empreinte TSX intermédiaire ; les corrections finales de motif et de présentation n’ont pas modifié le renderer ou le transport. Les étapes fonctionnelles ont progressé entre les corrections UI : aucune répétition intégrale de chaque action sur le dernier CSS n’est revendiquée.

L’arrêt volontaire du serveur de recette restitue aussi le rejet initial de lecture de contexte, déjà corrigé, et une erreur `Failed to fetch` d’un contrôle QA local antérieur. La cause de cette dernière n’est pas établie ; les réinitialisations et essais complémentaires suivants ont réussi. Les tableaux de logs sauvegardés après le rechargement et la nouvelle revue sont vides, sans revendiquer que toute la session antérieure était exempte d’erreur. L’arrêt par Ctrl-C sort1 intentionnellement ; ce n’est pas le résultat du build.

## 6. Risques identifiés

Le périmètre reste **US/USD/accrual, local privé TEST**. La provenance d’un CSV manuel ne garantit pas l’authenticité bancaire. Le rapprochement ne crée pas de paiement ni d’écriture financière et ne résout pas automatiquement les frais manquants ou les différences. Une réponse incertaine reste bloquante ; sa reprise conserve l’UUID, le corps et les attentes F/B/R initiaux. Les demandes et brouillons ne sont pas persistés hors RAM.

Les budgets cumulatifs du protocole, du registre et du livre continuent de s’appliquer : pagination et export ne les étendent pas. Le CSV complet n’est pas tronqué à la page visible. Les mesures et captures sont celles d’un navigateur de test, pas d’un iPhone ou d’un paquet natif. La recette visuelle n’est pas le produit cartésien de toutes les langues, tailles et états. Les métadonnées de 13px et certains rayons de 8px ont fait l’objet de remarques consultatives du détecteur, cohérentes avec le panneau financier existant ; aucun blocage de design n’a été relevé. Le pied de page de contrôle QA en anglais est hors produit, et les données saisies fictives ne sont pas traduites.

## 7. Fonctionnalités terminées

Dans le pilote local : liste et lecture des relevés ; import CSV manuel et revue paginée ; sélection exacte avec visibilité des choix hors page ; totaux signés BigInt ; approbation explicite et invalidation en cas de changement ; enregistrement/annulation motivée ; reprise exacte après réponse perdue ou409 tardif ; rechargement avec avertissement ; comparaison courante distincte de la clôture historique ; legacy protégé ; export complet ; interface traduite et responsive clair/sombre.

L’intégration ne crée ni deuxième timer, ni store bancaire concurrent, ni branche ERP4. Les invariants financiers et d’autorisation restent portés par les couches existantes. Les contrôles temporaires QA ne sont montés dans aucune route produit.

## 8. Fonctionnalités expérimentales et suite

Le pilote ERP US global demeure incomplet et l’objectif international reste actif. Restent notamment : provisioning/admission hébergés et natifs, prestataire fiscal réel et validation professionnelle, cash basis, clôture annuelle complète, workflows Support/Automation et originaux, commandes/projets avancés, charge, exploitation et distribution. Cette livraison ne constitue ni une certification US GAAP, ni une promesse de conformité des cinquante États, ni une connexion à une banque réelle.

La prochaine tranche doit partir d’un plan ciblé après revue des gaps vérifiés, en conservant le livre cumulatif et la protection CH. Les tarifs, migrations de production et services externes restent soumis aux décisions explicites prévues par la mission. Les anciens relevés d’état sont conservés dans STATUS sans être réécrits.
