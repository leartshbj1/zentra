# Refonte et capacité — état vérifié du 29 septembre 2026

L’objectif reste la refonte de toute l’application et le fonctionnement fiable de nombreux appareils simultanés, avec les vingt points de l’[audit premier client](AUDIT-PREMIER-CLIENT-ETAT-20260928.md). Ce lot ne redéfinit pas cet objectif autour du seul tableau de bord. **Objectif encore actif ; aucune certification globale.**

## Changements livrables

- Natif `55152c8b` : index temporaires des relations financières construits une fois par chargement. Ordre, centimes, liens et séparation des entreprises conservés. [Mesures et périmètre](NORMALISATION-HISTORIQUE-FINANCIER-20260929.md).
- Natif `1a4767f0` : lecture du tableau de bord « finances → actions choisies → suivi », ouverture de la facture exacte depuis son échéance, traductions des panneaux concernés, montants et navigation adaptés à 320px/200 % de texte. La version des installateurs reste 1.90.7 à ce stade ; ces deux commits ne sont pas encore distribués.
- Serveur `078d3fa73a4509aff22e519c9877be207cbe560b` : accusés de souscription répétés sans lectures redondantes, budget de connexion borné, nettoyage immédiat des sockets interrompus et lecture finale durable. Un socket reçu après annulation est accepté puis fermé selon les contraintes workerd.

## Preuves et portée

### Tableau de bord et calculs locaux

- Six configurations navigateur et huit captures : ordinateur clair/sombre, français/anglais, téléphones français/italien, allemand à 320px et texte 200 %. [Rapport](../.impeccable/review/dashboard-workflow/report.json).
- Raccourcis en lecture seule désactivés et ouverture de F-2026-001 dans son propre document. Données fictives exclusivement.
- Les trois groupes numériques contrôlés restent entiers dans leur surface ; quatre destinations du dock activées au toucher, accueil et Menu activés au clavier, cinq contrôles visibles d’au moins 44px. Le complément de capture montre le solde entièrement accessible en faisant défiler l’écran, contrairement à la superposition du dock sur une capture pleine page.
- [Verdict indépendant](../.impeccable/review/dashboard-workflow/review.md) : **ship** pour les cinq corrections demandées. Aucun verdict global sur tous les écrans ou sur les appareils physiques.
- Après la dernière modification du formateur monétaire : **24 tests ciblés réussis**, un test de profilage explicitement ignoré. Langues, centimes et devises, rapports, échéances, relations financières et indexation couverts.
- `pnpm build:web` réussi (vérification de marque, palette sombre, TypeScript et Vite). Le comparatif de normalisation est distinct du démarrage : 6 000 entrées par famille, 1 727,99 → 36,36 ms pour cette étape seule, réponse complète identique. La précédente suite de 1 827 tests précède le dernier lot de présentation ; elle ne vaut pas réexécution de toute la suite après ce lot.

### Serveur

- **42 tests ciblés réussis** au total : realtime 17, collaboration 12, sécurité du compte 5, routes de collaboration 8. TypeScript et `git diff --check` réussis.
- Reproduction dans le véritable runtime workerd : après annulation pendant la poignée de main, rejet `AbortError` et socket `CLOSING` (2), au lieu de `OPEN` (1).
- Les 450 abonnements / 150 entreprises sont un scénario simulé de nettoyage et d’isolation. Ils ne prouvent pas la capacité du serveur de production. Le coût résiduel des lectures à vide et des nouvelles connexions doit être mesuré sous charge réelle.
- Version **Sites 297 publiée avec succès**, le 28 septembre à 23:58:39 UTC (29 septembre 01:58 CEST), révision d’environnement 37. Déploiement `appgdep_6abaff19462081919c724a74845b4e0b`, version `appgprj_6a942972adf481918671ac74e99e1fa7~appgver_fff4a50fd4c081918b0b053bb0edafa3`.
- Archive exacte : 701 fichiers. Le script Sites Windows a échoué à lancer le gestionnaire de paquets, puis le répertoire du plugin a disparu. Repli : `pnpm.cmd build` réussi, commit propre poussé sans forçage et vérifié sur la branche source, archive `dist/` conforme aux trois archives précédentes, empreintes de tous les fichiers comparées avant/après conditionnement. Publication effectuée par les outils Sites natifs. Aucun secret écrit dans l’archive ou les sources.

## Blocages d’exploitation constatés

Le tableau de bord Supabase de l’organisation indique encore **Free**, **Services restricted**, **Egress Exceeded** et **Storage Size Exceeded**. Les derniers journaux serveur confirment `company.watch` / `company.read` : refus Supabase 402 sur `zentra_workspaces`, présenté en 503 côté application. La publication 297 ne lève pas cette restriction. Une demande d’activation de Pro a été envoyée à l’utilisateur ; aucun paiement ou changement d’offre effectué.

Le workflow GitHub de synchronisation des mails est `disabled_manually`. Sa dernière exécution connue `36339873810` n’a exécuté aucune étape, le compte étant verrouillé pour facturation. Aucun traitement automatique de mails réels, application fermée, n’est revendiqué. Le contrôle de santé authentifié n’a pas été exécuté : la clé d’exploitation n’est pas accessible dans les valeurs masquées de configuration.

## Reste à démontrer pour l’objectif complet

1. Distribuer les nouveaux commits natifs avec une version distincte, et vérifier l’installation/mise à jour avec les signatures et appareils appropriés. Une compilation web n’est pas un nouvel installateur.
2. Après rétablissement de Supabase, mesurer la propagation réelle émission/encaissement/remboursement entre deux comptes et appareils, avec brouillon ouvert, déconnexion et reprise, puis charge représentative de plusieurs entreprises.
3. Restaurer un planificateur effectif de messagerie, observer plusieurs cycles applications fermées, puis les erreurs/reprises et une alerte réellement reçue.
4. Terminer la recette inscription, abonnement test, invitations, changement d’espace, fichiers, restauration et automatisation avec les comptes opérationnels.
5. Poursuivre les surfaces et parcours encore non validés de la refonte complète, les contenus longs et technologies d’assistance, ainsi que le démarrage natif à froid sur machine modeste. Le lot du tableau de bord n’est pas une validation des autres écrans.

Les contrôles déjà réussis ne doivent être répétés que si une modification ou un risque nouveau le justifie. Les essais connectés attendent la levée de la restriction Supabase.

## Suite du 29 septembre — distribution native

La préparation 1.90.8 est gelée dans `cc92d4cf31d4cbcff61fe4ad285ab6cd4cded0e3` et poussée sur `codex/first-client-release-1908`. Les 11 tests relatifs aux notes de version, langues et contrats updater passent, les quatre versions sont cohérentes et les conditions du workflow évitent les compilations en double. Android 175 et Apple 176 ont réussi, ainsi que la recette Android 177 du contenu exact ; paquets Apple/Android récupérés et vérifiés, Mac signé pour l'updater et Android avec l'identité persistante de préversion. Windows 174 compile encore lors du contrôle de 00:51 UTC. [Suivi de la version et liens des jobs](RELEASE-1.90.8.md). La publication native reste 1.90.7.

## Suite du 29 septembre — réservation et lots de messagerie

Le serveur `766e9256df7eb611375f21c49707ba6bbe445713` est publié en **Sites 298**, déploiement `appgdep_6abb0b5a15b08191b1286796df8a3876` réussi à 00:50:56 UTC, environnement inchangé (37). Réservation atomique de la boîte due, quatre boîtes maximum et deux simultanées, contrôles de bail et compteurs de retard. Les unités admises finissent et enregistrent leur résultat même lorsqu'une lecture ou préparation lente dépasse le budget d'admission : trois régressions de famine ont été reproduites puis corrigées avant publication.

Dans le checkout autoritatif : **214 tests / dix fichiers réussis**, TypeScript réussi et compilation Sites réussie. La recette PostgreSQL/PGlite valide les huit créneaux et les résultats HTTP avec fournisseurs remplacés par des simulations locales, sans réseau ; le SQL testé correspond au SQL publié à la normalisation des fins de ligne près. Les pages `/` et `/download` répondent 200 ; `/api/support/mail-sync` refuse correctement une lecture anonyme (401).

Cette publication n'active ni Supabase Cron, ni secret, ni l'indicateur d'Automation en arrière-plan. Le SQL d'activation reste commenté. La simulation de 150 boîtes prouve la réservation et l'équité de la file, pas la capacité de production. Les restrictions Supabase et les étapes de recette connectée restent ouvertes. Les éléments de publication sont conservés dans `outputs/release1908/scheduler-publish-proof.json`.
