# Supervision des traitements simultanés

27 septembre 2026. Suite des points 2 et 7 de l’audit premier client.

## Défauts corrigés

Le suivi du worker comparait seulement les dates. Si un premier appel terminait après le début d’un deuxième, sa fin pouvait faire paraître le deuxième terminé alors qu’il restait bloqué. Chaque passage possède maintenant une identité aléatoire. Seule la première fin du passage actuellement suivi peut modifier son résultat ; une fin ancienne ou rejouée ne rafraîchit plus la santé. Des débuts dans la même milliseconde restent distincts. Les logs de chaque cycle sont conservés séparément : le suivi global n’est pas un historique des incidents de toutes les entreprises.

La migration additive `0065_scheduler_run_identity.sql` ajoute deux colonnes facultatives sans effacer l’historique. Les anciennes lignes restent lisibles jusqu’au premier nouveau passage. L’authentification précède toujours le suivi ; si le stockage du suivi tombe en panne, le traitement métier peut continuer, sans annoncer une santé vérifiée.

Le client planifié pouvait terminer avec succès après 60 lots ou 12 minutes sans confirmation que les files immédiatement disponibles étaient terminées. Il signale désormais cette limite comme un échec observable, publie uniquement un résumé de compteurs et ajuste le délai de la dernière requête au temps restant. Une réponse HTTP invalide ou des compteurs non numériques ne sont pas acceptés comme une réussite. Il ne journalise ni contenu de réponse ni jeton.

## Validation

84 tests réussis dans six fichiers : santé durable sur SQLite et migrations réelles, authentification du planificateur, endpoint GET sans traitement, POST avec corrélation de passage, diagnostics, client planifié exécuté dans une simulation HTTP et règles Automation. Comprend une fin ancienne pendant un nouveau passage bloqué, deux débuts simultanés, une fin rejouée, l’historique préexistant, la panne de stockage, le budget de temps et de lots, les réponses invalides et les compteurs sensibles refusés.

TypeScript, lint ciblé, contrôle des ressources de marque et compilation de production réussis. Les tests sont isolés : aucun e-mail envoyé, aucun classement réel ni abonnement modifié. Ils ne prouvent pas la capacité de 150 entreprises ni l’exécution d’un planificateur extérieur.

## État opérationnel et suite

Contrôle GitHub du 27 septembre : workflow `support-mail-sync.yml` **disabled_manually**, dernière exécution observée `35506667301` en échec le 20 septembre. Configuration distante Sites révision 36 : le drapeau `SUPPORT_MAIL_BACKGROUND_ENABLED` est absent. Le blocage de facturation antérieur n’a pas été réévalué par ce seul contrôle. Le script de remplacement Supabase reste une préparation, pas une preuve d’activation.

Ce lot serveur n’active pas le planificateur, ne configure pas un destinataire d’alerte et ne fabrique aucun installateur. La copie du client GitHub doit être intégrée au dépôt et à la branche réellement utilisés par un planificateur avant activation ; publier le serveur Sites ne publie pas ce workflow sur GitHub.

Pour la recette réelle : rétablir l’accès aux comptes, choisir et activer un planificateur disponible, observer plusieurs passages authentifiés, fermer les interfaces et vérifier une pièce fictive autorisée. Tester ensuite une interruption et sa reprise sans doublon. Brancher un moniteur indépendant sur le GET protégé, vérifier la réception effective d’une alerte, puis seulement annoncer le fonctionnement lorsque Support est fermé. Mesurer séparément le retard par entreprise et la capacité avec des pièces réalistes.
