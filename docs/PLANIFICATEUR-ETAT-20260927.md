# Planificateur Support — contrôle du 27 septembre 2026 à 20 h 14

Le client corrigé de `.github/workflows/support-mail-sync.yml` a été installé dans la branche GitHub effectivement utilisée, `master`, commit **59dcf5ba3ab54aff1e77401179b377009bc7697a**. Modification d’un seul fichier avec contrôle du blob précédent ; relecture des octets publiés identique. Les 36 tests ciblés du dépôt serveur passent. Aucun paramètre de compte ni drapeau d’exécution autonome n’a été modifié.

Une activation et un déclenchement explicites ont produit l’exécution [36339873810](https://github.com/leartshbj1/zentra/actions/runs/36339873810), sur ce même commit. Le job `sync` **108677740070** a échoué avant toute étape :

> The job was not started because your account is locked due to a billing issue.

Le workflow a donc été remis à l’état `disabled_manually`, puis cet état a été vérifié. **Aucun traitement de courrier n’a été exécuté par cet essai.** La présence du secret configuré et la publication du workflow ne prouvent pas l’autonomie. Le dernier contrôle Supabase connu à 20 h 05 reste HTTP 402 pour les quotas de stockage et de transfert.

Preuves copiées sans secret dans `outputs/first-client-operations/` : `scheduler-promotion-proof.json`, `scheduler-run-36339873810.json`, `scheduler-annotations-36339873810.json`. Les journaux de tests sont dans le dépôt serveur, `.qa/scheduler-promotion-tests.log`.

Restent nécessaires : rétablissement de l’exécution planifiée, passage réel applications fermées, contrôle du rattrapage, réception d’une alerte externe et validation des comptes connectés. Ni les 150 entreprises simultanées ni l’absence de pertes ne sont déduites des tests isolés.
