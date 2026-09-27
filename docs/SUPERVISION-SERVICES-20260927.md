# Santé des services — 27 septembre 2026

## Portée

`GET /api/operations/health` fournit un diagnostic réservé à la supervision. Il lit l'accessibilité du service de comptes, le dernier signal du planificateur et les files de traitement. Il ne lance aucun traitement et ne modifie aucune donnée.

La clé `OPERATIONS_MONITOR_TOKEN` est distincte de celle qui autorise le planificateur. Elle doit être transmise uniquement dans l'en-tête `Authorization: Bearer …`, depuis le coffre du service de supervision. Ni paramètre d'URL ni cookie ne l'autorisent. Elle est enregistrée comme secret Sites ; aucune valeur n'est conservée dans ce dépôt.

## Réponses

- **401** : accès non autorisé, aucun accès aux données ni appel au service de comptes.
- **200** : service de comptes accessible, planificateur récent et vérifié, files sans incident détecté.
- **503** : panne, restriction, retard, erreur de file, planification inactive ou état impossible à vérifier. Ce résultat ne doit jamais être interprété comme une file vide.

Les réponses portent `Cache-Control: no-store`. Les champs retournés se limitent aux états, compteurs, dates et durée du contrôle. Aucun client, e-mail, contenu de facture, objet de message, identifiant d'entreprise ou secret n'est retourné.

Le contrôle Supabase lit `/auth/v1/settings` avec la clé publique et refuse les redirections, les réponses malformées et les corps au-delà de 16 Kio. Son délai maximal est de quatre secondes. Chaque composante du diagnostic est bornée à cinq secondes. Une lecture réussie confirme l'accès au service ; elle ne valide pas une inscription, une connexion réelle ou l'envoi SMTP.

## Interprétation des files

Les connexions désactivées, espaces Support en pause et règles désactivées sont exclus. Un traitement dû depuis plus de quinze minutes est signalé comme retard. Un bail expiré signale un traitement à reprendre. Une attente future ou une validation humaine n'est pas un retard. Les tickets encore en attente d'un abonnement ou d'un consentement Automation sont comptés sans déclencher à eux seuls une alerte de retard.

Les erreurs persistantes restent visibles même si le planificateur répond. Un nouveau compte de messagerie dont la première échéance vaut zéro utilise sa date de création, pour éviter un faux retard depuis 1970. Les compteurs sont globaux ; ils ne constituent ni une mesure de latence par entreprise ni une preuve de capacité pour 150 entreprises.

La migration additive 0066 ajoute l'index `support_ticket_operations`. Elle ne supprime aucune donnée.

## Validation

69 tests sur cinq fichiers passent, dont 29 pour ce contrôle : autorisation, confidentialité, panne 402, délais, réponses invalides, vraie lecture SQLite avec les schémas de production, files actives/inactives, verrous, index et absence d'écritures. TypeScript, lint ciblé, ressources de marque et compilation de production réussissent. Le lanceur pnpm Windows du script de build a échoué avant compilation ; le même build a ensuite réussi via le CLI vinext installé, sans modifier les dépendances.

La première publication (Sites 289) a correctement refusé les accès non autorisés et révélé une boîte en retard, mais son appel Supabase échouait avant la requête : Workers refuse `redirect: 'error'`. Le contrôle utilise désormais `redirect: 'manual'` et rejette lui-même toute réponse 3xx. Une recette sur le vrai moteur workerd local reproduit l'échec de l'ancien mode puis confirme un seul appel à l'origine, réponse 302, sans suivre la redirection. Les 69 tests et le build ont été rejoués après cette correction. La preuve locale est dans `.qa/operations-worker-proof.json` ; la réponse du premier déploiement est conservée séparément, sans la présenter comme une réussite du contrôle Supabase.

## Mise en service restante

L'endpoint seul n'envoie **aucune alerte**. Il faut encore le relier à un moniteur externe, conserver la clé dans son coffre, puis vérifier la réception d'une alerte de panne et d'un rétablissement. Une fréquence d'une minute et deux échecs consécutifs sont un point de départ ; une réponse 401 doit signaler un défaut de configuration et non un rétablissement.

Les quotas Supabase et le planificateur désactivé restent des incidents distincts à résoudre. Ce lot ne réactive pas le traitement des e-mails, ne modifie aucun abonnement d'hébergement et ne publie aucun installateur natif. La preuve de publication et le dernier état réel sont consignés dans `docs/ETAT-LIVRAISON.md` du dépôt natif et dans les artefacts `.qa/operations-*` de ce checkout.
