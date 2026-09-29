# Refonte et capacité — état vérifié du 29 septembre 2026

L’objectif reste la refonte de toute l’application et le fonctionnement fiable de nombreux appareils simultanés, avec les vingt points de l’[audit premier client](AUDIT-PREMIER-CLIENT-ETAT-20260928.md). Ce lot ne redéfinit pas cet objectif autour du seul tableau de bord. **Objectif encore actif ; aucune certification globale.**

État courant au 29 septembre, contrôles de publication jusqu’à 02:50 UTC (04:50 Europe/Zurich) : **1.90.9 publiée sur les quatre plateformes et Sites 300 réussi**. Les sections ci-dessous conservent leurs preuves datées ; [la publication 1.90.9](RELEASE-1.90.9.md) distribue aussi la projection allégée. Les validations connectées, signatures commerciales, appareils physiques et capacité restent ouverts. La mesure de volume Windows 188 échoue avant SQLite, sans preuve de régression applicative ni mesure IPC/rendu obtenue.

## Changements livrables

- Natif `55152c8b` : index temporaires des relations financières construits une fois par chargement. Ordre, centimes, liens et séparation des entreprises conservés. [Mesures et périmètre](NORMALISATION-HISTORIQUE-FINANCIER-20260929.md).
- Natif `1a4767f0` : lecture du tableau de bord « finances → actions choisies → suivi », ouverture de la facture exacte depuis son échéance, traductions des panneaux concernés, montants et navigation adaptés à 320px/200 % de texte. Ce lot et la normalisation `55152c8b` sont distribués dans la version **1.90.8**, source commune `cc92d4cf31d4cbcff61fe4ad285ab6cd4cded0e3`.
- Serveur `078d3fa73a4509aff22e519c9877be207cbe560b` : accusés de souscription répétés sans lectures redondantes, budget de connexion borné, nettoyage immédiat des sockets interrompus et lecture finale durable. Un socket reçu après annulation est accepté puis fermé selon les contraintes workerd.

## Preuves et portée

### Tableau de bord et calculs locaux

- Six configurations navigateur et huit captures : ordinateur clair/sombre, français/anglais, téléphones français/italien, allemand à 320px et texte 200 %. [Rapport](../.impeccable/review/dashboard-workflow/report.json).
- Raccourcis en lecture seule désactivés et ouverture de F-2026-001 dans son propre document. Données fictives exclusivement.
- Les trois groupes numériques contrôlés restent entiers dans leur surface ; quatre destinations du dock activées au toucher, accueil et Menu activés au clavier, cinq contrôles visibles d’au moins 44px. Le complément de capture montre le solde entièrement accessible en faisant défiler l’écran, contrairement à la superposition du dock sur une capture pleine page.
- [Verdict indépendant](../.impeccable/review/dashboard-workflow/review.md) : **ship** pour les cinq corrections demandées. Aucun verdict global sur tous les écrans ou sur les appareils physiques.
- Après la dernière modification du formateur monétaire : **24 tests ciblés réussis**, un test de profilage explicitement ignoré. Langues, centimes et devises, rapports, échéances, relations financières et indexation couverts.
- `pnpm build:web` réussi (vérification de marque, palette sombre, TypeScript et Vite). Le comparatif de normalisation est distinct du démarrage : 6 000 entrées par famille, 1 727,99 → 36,36 ms pour cette étape seule, réponse complète identique. La précédente suite de 1 827 tests précède le dernier lot de présentation ; elle ne vaut pas réexécution de toute la suite après ce lot.
- [Profilage Rust optimisé de la source 1.90.8](VOLUMES-OPTIMISES-20260929.md) : trois passages réussis après échauffement sur 5 001 factures et 5 001 devis fictifs. Lecture médiane de l’espace **1 289,95 ms**, sérialisation **162,17 ms**, réponse **49 718 748 octets**. Les valeurs avant/après sérialisation et les empreintes des 110 tables métier et trois pièces sont conservées. Binaire de test GNU distinct de l’installateur MSVC ; ouverture à froid, verrou applicatif, IPC, normalisation JavaScript et rendu exclus. Aucun gain global comparé au debug, aucune preuve sur machine modeste ou de capacité de 150 entreprises. Une éventuelle projection allégée reste un travail séparé, sans livraison déduite de ce profilage.

### Serveur

- **42 tests ciblés réussis** au total : realtime 17, collaboration 12, sécurité du compte 5, routes de collaboration 8. TypeScript et `git diff --check` réussis.
- Reproduction dans le véritable runtime workerd : après annulation pendant la poignée de main, rejet `AbortError` et socket `CLOSING` (2), au lieu de `OPEN` (1).
- Les 450 abonnements / 150 entreprises sont un scénario simulé de nettoyage et d’isolation. Ils ne prouvent pas la capacité du serveur de production. Le coût résiduel des lectures à vide et des nouvelles connexions doit être mesuré sous charge réelle.
- Version **Sites 297 publiée avec succès**, le 28 septembre à 23:58:39 UTC (29 septembre 01:58 CEST), révision d’environnement 37. Déploiement `appgdep_6abaff19462081919c724a74845b4e0b`, version `appgprj_6a942972adf481918671ac74e99e1fa7~appgver_fff4a50fd4c081918b0b053bb0edafa3`.
- Archive exacte : 701 fichiers. Le script Sites Windows a échoué à lancer le gestionnaire de paquets, puis le répertoire du plugin a disparu. Repli : `pnpm.cmd build` réussi, commit propre poussé sans forçage et vérifié sur la branche source, archive `dist/` conforme aux trois archives précédentes, empreintes de tous les fichiers comparées avant/après conditionnement. Publication effectuée par les outils Sites natifs. Aucun secret écrit dans l’archive ou les sources.

## Blocages d’exploitation constatés

Le diagnostic d’exploitation antérieur à la publication 297 relevait **Free**, **Services restricted**, **Egress Exceeded** et **Storage Size Exceeded** dans le tableau de bord Supabase, avec refus 402 sur `zentra_workspaces` dans les journaux `company.watch` / `company.read`, présenté en 503 côté application. Une demande d’activation de Pro avait été envoyée à l’utilisateur ; aucun paiement ou changement d’offre n’a été effectué par ce travail.

La nouvelle sonde du **29 septembre à 01:09:30.902 UTC**, après Sites 299, reçoit toujours **503**, « L’authentification est temporairement indisponible. ». Elle tente une connexion avec une adresse fictive inexistante et l’origine requise, sans connexion réelle, inscription ni demande d’e-mail. Preuve : `outputs/release1908/auth-readiness.json`. **Cette sonde ne contrôle pas directement la facturation Supabase** et ne réactualise pas à elle seule les anciens constats du tableau de bord ; elle ne fournit aucune preuve de rétablissement de l’authentification.

Le workflow GitHub de synchronisation des mails est `disabled_manually`. Sa dernière exécution connue `36339873810` n’a exécuté aucune étape, le compte étant verrouillé pour facturation. Aucun traitement automatique de mails réels, application fermée, n’est revendiqué. Le contrôle de santé authentifié n’a pas été exécuté : la clé d’exploitation n’est pas accessible dans les valeurs masquées de configuration.

## Reste à démontrer pour l’objectif complet

1. Compléter la distribution 1.90.9 désormais publique par les signatures reconnues et les essais d’installation/mise à jour sur les appareils appropriés. Les recettes cloud et émulateur ne lèvent pas le refus Code Integrity de ce PC et ne remplacent pas les appareils physiques.
2. Après rétablissement de Supabase, mesurer la propagation réelle émission/encaissement/remboursement entre deux comptes et appareils, avec brouillon ouvert, déconnexion et reprise, puis charge représentative de plusieurs entreprises.
3. Restaurer un planificateur effectif de messagerie, observer plusieurs cycles applications fermées, puis les erreurs/reprises et une alerte réellement reçue.
4. Terminer la recette inscription, abonnement test, invitations, changement d’espace, fichiers, restauration et automatisation avec les comptes opérationnels.
5. Poursuivre les surfaces et parcours encore non validés de la refonte complète, les contenus longs et technologies d’assistance, ainsi que le démarrage natif à froid sur machine modeste. Le lot du tableau de bord n’est pas une validation des autres écrans.

Les contrôles déjà réussis ne doivent être répétés que si une modification ou un risque nouveau le justifie. Les essais connectés attendent la levée de la restriction Supabase.

## Suite du 29 septembre — distribution native

La version 1.90.8 est gelée dans `cc92d4cf31d4cbcff61fe4ad285ab6cd4cded0e3` et poussée sur `codex/first-client-release-1908`. Les 11 tests relatifs aux notes de version, langues et contrats updater passent, les quatre versions sont cohérentes et les conditions du workflow évitent les compilations en double. **Windows 174, Android 175, Apple 176 et les recettes Android 177 / Windows 178 ont tous réussi**. Le vérificateur Windows/Android est `c94162093f978cd160f6ae05a569d3a1ea9167ea` ; il teste le contenu de la source applicative commune. Les paquets ont été récupérés et vérifiés, les signatures updater Windows/Mac contrôlées, l’APK signé avec l’identité persistante de préversion. Les recettes Mac, Windows et Android restent bornées à leurs profils isolés et à l’émulateur. [Version, provenance et liens des jobs](RELEASE-1.90.8.md).

**Douze actifs GitHub publiés à 01:01:04 UTC**, puis **Sites 299 réussi à 01:08:28 UTC**, source `dcf9a0d726acdb59072284e4ae4c32ed1d64d667`, environnement 37 inchangé. Les quatre liens principaux répondent HTTP 200 avec leurs tailles exactes et les trois manifestes annoncent 1.90.8 en `no-store`, conformes aux fichiers locaux à 01:08:58 UTC. Preuves dans `outputs/release1908/{github-published-proof,site-publish-proof,public-head-proof,update-channel-live-proof}.json` ; succès des jobs et paquets dans `build-status.json` et les sous-dossiers de téléchargement/recette.

La page `/download` répond aussi HTTP 200 et contient les quatre références 1.90.8 à 01:11:02 UTC : `outputs/release1908/download-page-proof.json`.

Windows n’a pas d’Authenticode et ce PC n’a pas été réinstallé ; Mac demeure ad hoc et non notarié, l’IPA non signée. Le certificat de l’APK public est distinct de celui de la recette émulateur. Aucun appareil physique, store ou capacité de 150 entreprises n’est validé par cette publication. Historique du 29 septembre à 00:51 UTC : Windows était encore en compilation et 1.90.7 restait publique ; ces deux statuts sont désormais remplacés par les preuves ci-dessus.

## Suite du 29 septembre — réservation et lots de messagerie

Le serveur `766e9256df7eb611375f21c49707ba6bbe445713` est publié en **Sites 298**, déploiement `appgdep_6abb0b5a15b08191b1286796df8a3876` réussi à 00:50:56 UTC, environnement inchangé (37). Réservation atomique de la boîte due, quatre boîtes maximum et deux simultanées, contrôles de bail et compteurs de retard. Les unités admises finissent et enregistrent leur résultat même lorsqu'une lecture ou préparation lente dépasse le budget d'admission : trois régressions de famine ont été reproduites puis corrigées avant publication.

Dans le checkout autoritatif : **214 tests / dix fichiers réussis**, TypeScript réussi et compilation Sites réussie. La recette PostgreSQL/PGlite valide les huit créneaux et les résultats HTTP avec fournisseurs remplacés par des simulations locales, sans réseau ; le SQL testé correspond au SQL publié à la normalisation des fins de ligne près. Les pages `/` et `/download` répondent 200 ; `/api/support/mail-sync` refuse correctement une lecture anonyme (401).

Cette publication n'active ni Supabase Cron, ni secret, ni l'indicateur d'Automation en arrière-plan. Le SQL d'activation reste commenté. La simulation de 150 boîtes prouve la réservation et l'équité de la file, pas la capacité de production. Les restrictions Supabase et les étapes de recette connectée restent ouvertes. Les éléments de publication sont conservés dans `outputs/release1908/scheduler-publish-proof.json`.

## Suite du 29 septembre — projection locale de l'interface

Après la publication 1.90.8, les deux retours UI de l'espace évitent les lectures exhaustives du journal que Comptabilité charge déjà séparément. Trois tests Rust `--release` réussissent, avec conservation des exports et des journaux extraits des sauvegardes et archives de collaboration. Le comparatif sur le même binaire et la même fixture de 5 001 factures/devis réduit le JSON de 49 718 748 à 40 778 676 octets, tous les champs conservés identiques. Les 110 tables métier et trois pièces gardent leurs empreintes. [Protocole, mesures et limites](VOLUMES-OPTIMISES-20260929.md).

Cette modification supplémentaire est **distribuée dans 1.90.9**. Sa source est figée dans `01ad1279b934113006398504163f309948d92e07`, avec les constructions 179/180/181, la recette Windows 184 et la recette Android 187 réussies. Les actifs publics 1.90.8 restent immuables. [Publication et contrôles de la nouvelle version](RELEASE-1.90.9.md). Les mesures locales après échauffement ne clôturent pas le démarrage à froid, le rendu/IPC, les appareils modestes ou la capacité de production.

Le job de volume Windows **189**, vérificateur `22f3056e`, s'arrête avant installation avec `not_measured` : le jeton du runner est élevé, d'intégrité High (`12288`). La garde exige un processus Medium non élevé pour que les paramètres privés WebView2 soient pris en compte. Le confinement dans les deux Jobs est établi, mais l'application n'est pas lancée ; ce résultat ne prouve donc pas la cause de l'échec 188. Preuves : `outputs/release1909/windows-volume-189/{result,containment,download-proof}.json`. Un worker restreint dans le seul environnement CI est étudié séparément, sans abaisser les protections du PC utilisateur.

## Suite du 29 septembre — accessibilité de l'assistant dans la paie

Un défaut distinct a été reproduit dans les modales partagées : l'assistant ouvert au-dessus d'une fiche exposait encore la fiche derrière lui dans l'arbre accessible et autorisait son focus programmatique. La pile des modales rend désormais les surfaces derrière la fenêtre active inertes et restaure leurs attributs à la fermeture. Le parcours fictif réussit sur Edge et WebKit, à 1440 et 320 pixels : un seul dialogue exposé, quarante tabulations sans échappée, retour aux deux contrôles d'origine, salaire `5123.45` conservé. [Preuves avant/après et limites](../.impeccable/review/modal-assistant-accessibility/report.md).

Ce correctif est **local, non distribué et absent de la source figée 1.90.9**. La présentation est conservée ; aucune certification de lecteur d'écran physique ou de tous les portails de l'application n'est déduite de ce parcours.
