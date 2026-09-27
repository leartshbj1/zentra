# Rendez-vous dans le journal Automation

Lot ajouté après le gel de **1.90.5**, donc **absent des installateurs actuellement publiés**. Interface Operate, activité en premier et identité existante conservées. Aucun service, compte, message ou droit modifié par cette livraison de code.

## Comportement

Les rendez-vous effectivement reçus rejoignent les factures et automatismes dans le journal. Le filtre et la recherche couvrent le titre, l’expéditeur, le lieu et la date. La chronologie utilise l’heure de traitement disponible, jamais la date future du rendez-vous pour fabriquer une activité récente. Ajout automatique, ajout manuel, annulation enregistrée, vérification, traitement et attente restent distincts.

Le détail présente la date et l’heure suisses, le lieu et l’expéditeur. Une date impossible ou manquante est annoncée comme indisponible ; elle n’est pas normalisée silencieusement vers une autre journée. Une fin invalide ou antérieure ne crée pas une plage horaire inventée. La même présentation est utilisée dans la réception des rendez-vous.

« Ouvrir le rendez-vous » mène à son jour exact, y compris pour un événement ancien ou annulé, et place le focus sur cet événement. Aucun formulaire d’édition ne s’ouvre automatiquement. Un rafraîchissement ultérieur ne reprend pas le focus. Si l’événement n’est plus disponible localement, un message explicite remplace l’ouverture d’une autre journée. Les rendez-vous encore à vérifier ouvrent la réception. Les boutons de modification conservent la lecture seule.

Les données de réception sont filtrées par entreprise avant affichage, y compris immédiatement lors d’un changement d’espace. Les réponses conservées d’une autre entreprise et les éléments dont l’organisation ne correspond pas restent cachés. Le journal peut présenter les rendez-vous disponibles indépendamment du chargement des règles. Ce lot n’augmente pas la fréquence de réception ni ne prouve un traitement serveur autonome.

## Vérifications

- **1 795 tests frontend / 221 fichiers**, TypeScript et build Vite réussis. Vingt tests dédiés couvrent notamment les états, les dates, les entreprises séparées, les événements annulés et l’absence locale. Preuves : `desktop/.qa/appointment-activity-suite.log`, `appointment-activity-tsc.log`, `appointment-activity-build.log`.
- **20 parcours navigateur réussis** : 16 variantes Chromium bureau / WebKit mobile, FR/DE/IT/EN et clair/sombre, puis quatre parcours dans le vrai `WorkspaceApp` avec services fictifs, à 390/1440 px sur les deux moteurs. Ouverture exacte, absence locale, changement d’entreprise, lecture seule, conservation du focus et retour de thème vérifiés. Les commandes du journal mesurées atteignent 44 px. Aucun débordement horizontal observé dans ce périmètre. Preuve : `desktop/.qa/appointment-activity-confirmation/proof.json`.
- Deux passes visuelles regroupées. La première a aussi révélé une date impossible transformée dans la liste de réception, corrigée. Les 16 premières variantes avaient attendu un mauvais sélecteur de fixture ; les quatre intégrations complètes passaient déjà. La seconde confirme les vingt parcours après correction du sélecteur et de la présentation des dates. Les captures ont été relues sur bureau et mobile, clair/sombre.
- Limite conservée : à 320 px et texte 200 %, le long titre allemand du journal se répartit au milieu du mot. Le contenu demeure accessible ; cette preuve n’est pas une certification d’accessibilité.

## Revue et tokens

Revue finale du diff : ajout de métadonnées et de navigation, sans changement des requêtes d’import, des identifiants ni des droits. L’état d’entreprise est vérifié à l’affichage et à l’ouverture. Le journal réutilise `ac-run`, ses faits et ses statuts existants ; aucune carte ni animation décorative supplémentaire. Le focus de l’agenda utilise `--work-accent`, repli clair `#286047`, et son adaptation générée sombre. Typographie et espacements existants conservés. FR/DE/IT/EN pour les nouveaux libellés ; contenu reçu inchangé.

Le lot est prêt à intégrer à une future version après gel de sa source. **Aucun test sur iPhone physique, aucun import réel d’e-mail et aucune publication binaire de ce lot ne sont revendiqués.** Le contrôle du 27 septembre à 20 h 05 confirme toujours Supabase HTTP 402, quotas de stockage et transfert dépassés. Le parcours réel de collaboration reste à vérifier après rétablissement du service.
