# Zentra — état courant des livraisons

Mis à jour le 27 septembre 2026, 20 h 10 (Europe/Zurich). L'objectif premier client reste en cours : ce relevé ne signifie pas que les vingt points sont clos.

## Version publique 1.90.5

Source commune gelée **`3dfe7849b1ee6d4c1195f89927c7fc134e1cb72d`**. Les douze fichiers de la [release 1.90.5](https://github.com/leartshbj1/zentra/releases/tag/v1.90.5) sont publiés depuis 19 h 32. Leurs empreintes GitHub correspondent aux fichiers vérifiés. Les quatre téléchargements principaux répondent anonymement HTTP 200 avec la taille attendue au contrôle de 19 h 34.

| Plateforme | Fichier | Contrôle exécuté | Limite de distribution |
|---|---|---|---|
| Windows x64 | `Zentra_1.90.5_x64-setup.exe`, 24 447 313 octets | Build 147, installation et deux démarrages du paquet par 149 ; installation locale sur ce PC et récupération synthétique réelle | Pas d'Authenticode ; signature du paquet updater vérifiée |
| macOS universel | `Zentra_1.90.5_macos-universal.dmg`, 54 658 074 octets ; archive 53 473 643 octets | Build 146, arm64/x86_64, démarrage et relancement isolés, SQLite 60 intègre, endpoint et clé vérifiés | Signature ad hoc, sans notarisation ; signature updater vérifiée |
| iPhone | `Zentra-1.90.5-iPhone-unsigned.ipa`, 26 091 537 octets | Build 146, arm64 iPhoneOS 15+, paquet vérifié | IPA non signé ; aucun essai iPhone physique ni publication App Store |
| Android | `Zentra-1.90.5-Android-arm64-test.apk`, 122 844 170 octets | Build 148, arm64, alignement 16 K, ressources et code/données ELF conservés lors de la suppression des symboles | Certificat de test persistant, débogable ; aucun essai appareil/émulateur ni publication Play Store |

Les signatures updater ne remplacent pas les signatures de distribution des systèmes. **Les manifestes Supabase historiques restent inchangés.** Les installations antérieures peuvent nécessiter une installation manuelle de 1.90.5 ; aucune proposition automatique sur tous les anciens appareils n'est déduite de la publication.

## Installation Windows et récupération réellement exécutées

Le nouvel installateur est installé dans le chemin standard du PC. Les vérifications ont utilisé uniquement un profil fictif séparé. L'application de recette est fermée ; aucune entreprise réelle ni licence n'a été remplacée.

1. Onboarding réel en 1.90.4 ; chemins de fichier/dossier préremplis, sélecteur Windows non testé ; logo traité par le natif. Jeu métier ensuite injecté hors ligne pour tester la récupération, sans prétendre valider sa création par l'interface.
2. Sauvegarde `.zentra` créée par la vraie commande native 1.90.4, puis installation 1.90.5. Les 110 tables métier/configuration contrôlées (17 non vides), les trois fichiers et les montants sont identiques après mise à jour.
3. Sauvegarde également créée par la vraie commande native 1.90.5. Vérification HTTPS de mise à jour réussie en 1 885 ms sans activation de compte. Le canal proposait alors 1.90.4 : aucun téléchargement/installation par l'updater n'est revendiqué.
4. Dossier source rendu inaccessible. Restauration de la sauvegarde 1.90.4 dans un profil neuf 1.90.5 ; PDF, photo et logo relus par le bridge natif, mêmes empreintes. Les 110 tables et les montants sont conservés : 1 000 CHF facturés, 250 CHF reçus, 750 CHF restant, 5 000 CHF de brut de paie fictif. Intégrité SQLite correcte.
5. Archive privée d'un document refusée avec un message compréhensible. Nouvelle comparaison identique, fichiers toujours lisibles ; les données présentes sont conservées. Dossier source fictif remis à sa place après les essais.

La licence reste absente dans les profils de test et les liaisons de compte ne sont pas importées. Ces preuves ne valident ni tous les parcours métier, ni le sélecteur natif, ni le partage/restauration mobile, ni deux appareils connectés.

Preuves : `outputs/release1905/github-published-proof.json`, `public-head-proof.json`, `installed-verification.json`, `smoke-windows/windows-smoke.json`, `smoke-macos/macos-smoke.json`, `upgrade-smoke/*-snapshot.json`, `restore-proof.json`, `reject-corrupt-proof.json`, `updater-proof.json` et `restored-stable.png`.

## Site et services

**Sites 291 publié à 19 h 39**, source `ca1ec4c62432ce68b03de99c4b732f9868ded545`, environnement 37, déploiement `appgdep_6ab954a5ca1481919dca796382bdffe8`. La page de téléchargement et les canaux indépendants du compte proposent 1.90.5. À 19 h 40, les trois manifestes `/updates/` répondent HTTP 200 anonymes, `no-store`, contenu exact ; le canal inconnu retourne 404. Quatorze tests de téléchargement/canal, TypeScript, ressources et compilation passent. Le lanceur Windows du build a échoué avant compilation ; le CLI vinext installé a ensuite produit le build, sans modifier les dépendances. Publication par le workflow Sites avec source poussée et archive vérifiée.

**Connexion toujours restreinte à 19 h 41** : lecture de `/auth/v1/settings` avec la clé publique, HTTP 402, dépassement du transfert et du stockage. Aucun compte/e-mail créé ni hébergement modifié. La requête sans clé effectuée juste avant a renvoyé 401 ; elle ne diagnostiquait pas le quota. Preuve actuelle : `outputs/release1905/account-health-latest.json`. Le rétablissement et les recettes authentifiées restent nécessaires.

**Supervision à 18 h 30 :** le contrôle autorisé `/api/operations/health` répond 503 en 284 ms : Supabase restreint, statut 402, planificateur inactif et une boîte dont l'échéance remonte au 24 septembre à 23 h 38 UTC. Les lectures des files réussissent ; aucun ticket ni règle en erreur n'est compté, ce qui ne prouve pas leur traitement autonome. Les accès anonyme et avec mauvaise clé renvoient 401. Aucun contenu client ni secret retourné. 69 tests isolés, TypeScript, lint, build et une recette workerd de redirection passent. Le premier déploiement 289 comportait une incompatibilité `redirect: error`, corrigée et revérifiée dans 290. **Aucun moniteur externe ni réception d'alerte encore validés.** [Portée et preuves](SUPERVISION-SERVICES-20260927.md).

**Planificateur non rétabli :** GitHub `support-mail-sync.yml` reste `disabled_manually` au contrôle de 17 h 20, dernière exécution observée le 20 septembre en échec. Aucun drapeau d’arrière-plan ajouté. La migration serveur 0065 empêche une fin ancienne ou rejouée de masquer un traitement récent bloqué. 84 tests isolés, TypeScript, lint, ressources de marque et compilation réussis. Le client planifié corrigé signale aussi une file non terminée à sa limite de temps ou de lots ; il est conservé dans le dépôt Sites, mais n’a pas été installé dans la branche GitHub exécutée par le planificateur. Ni traitement réel fermé, ni réception d’une alerte, ni capacité de 150 entreprises prouvés. Voir le lot serveur `docs/SCHEDULER-CONCURRENCE-20260927.md`.

**Connexion non rétablie :** le contrôle synthétique du 27 septembre à 16 h 53 a reçu HTTP 503 en 3,52 s, `Retry-After: 60`, `no-store`. Le contrôle direct Supabase à **17 h 26** confirmait **HTTP 402**, `exceed_egress_quota` et `exceed_storage_size_quota` ; le nouveau contrôle serveur confirme encore 402 à **18 h 30**. Aucun compte ni e-mail créé. Une capture de l’offre et de l’usage est demandée ; aucun abonnement d’hébergement modifié. Les essais réels de collaboration, d’abonnement et d’envoi partagé restent à faire.

## Lots inclus et travaux restants

1.90.5 inclut la messagerie partagée par entreprise, le catalogue traduit, les commandes tactiles, les premiers pas Comptabilité/Banque/Relances, les vérifications complètes de sauvegarde, les listes mobiles et le canal updater indépendant. Les lots précédemment notés absents de 1.90.4 sont désormais inclus dans cette source gelée. Les notes historiques conservent leurs limites de validation.

Le lot **`43331dab` Détails Automation**, ajouté après gel, n'est **pas** inclus : dates invalides sécurisées, choix radio lisibles, commandes et étapes traduites. 42 tests, 16 parcours navigateur synthétiques et build réussis ; détail dans [AUTOMATION-DETAILS-20260927.md](AUTOMATION-DETAILS-20260927.md). Limite de titre allemand à 200 %/320 px documentée.

Le lot [Rendez-vous Automation](AUTOMATION-RENDEZ-VOUS-20260927.md), également postérieur au gel et **non publié**, ajoute les rendez-vous effectivement reçus au journal et leur ouverture au jour exact de l’agenda. Dates invalides et absence locale sont explicites, événements annulés accessibles, lecture seule et séparation d’entreprise conservées. 1 795 tests frontend, TypeScript, build et 20 parcours navigateur passent. Données fictives : aucun traitement de messagerie réel ni appareil mobile physique vérifié. **Contrôle Supabase du 27 septembre à 20 h 05 : toujours HTTP 402**, stockage et transfert dépassés ; preuve actualisée `outputs/release1905/account-health-latest.json`.

Restent notamment : rétablissement des comptes, traitement lorsque les apps sont fermées, moniteur externe avec alerte reçue, deux installations synchronisées et reprise hors ligne, paiements/quotas/invitations réels, signatures de distribution et appareils physiques, sélecteurs natifs, traductions des outils avancés et poids du frontend. Les résultats isolés ne démontrent pas une capacité de 150 entreprises. Ne jamais modifier une source gelée déjà publiée.
