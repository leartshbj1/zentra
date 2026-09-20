# Phase 2 — audit et plan, 21 septembre 2026

## Périmètre vérifié avant modification

Source site publiée 71e85d97, application 1.76.0. Le dossier principal contient de nombreux changements non publiés : il est laissé intact. Les deux versions livrées servent de base.

Reconstruction des 56 migrations D1 : 85 tables, 80 clés étrangères, 9 déclencheurs, `integrity_check=ok`. Graphe complet dans `outputs/phase2/schema-audit.json`. Le catalogue du site distant a été consulté en lecture seule. Il ne constitue pas un export complet des données.

- Supabase Auth porte l'identité vérifiée ; cookies serveur HttpOnly, PKCE et récupération dédiée existent.
- D1 porte les membres, abonnements dérivés de Stripe, licences, invitations, synchronisation, Support et Automation. R2 porte les fichiers privés. Supabase porte aussi les profils d'entreprise et le contenu collaboratif. SQLite conserve les données métier de chaque appareil.
- Les migrations Supabase déclarent la RLS. L'isolation D1 dépend des API serveur et des requêtes liées à l'entreprise. Les deux protections doivent être testées séparément.
- Stripe reste la source des paiements. Les webhooks vérifient leur signature, relisent l'abonnement et utilisent des identifiants idempotents. Les droits payés sont séparés du simple statut commercial.

## Problèmes constatés

1. `getZentraUser` peut encore reprendre une identité Sites lorsque les cookies Zentra sont absents. Ce secours est incompatible avec un compte public unique.
2. Le portail Gestion exige le cookie d'une ancienne session Checkout ; il ne suffit pas d'être le propriétaire connecté. La gestion quotidienne doit partir de l'entreprise autorisée.
3. `/compte` charge et affiche les accès de toutes les entreprises dans une longue page. Absence de profil éditable, préférences partagées, changement d'adresse, suppression guidée et véritable accueil de première connexion.
4. L'inscription affiche le formulaire avant la fin du contrôle de session. Les mutations doivent empêcher les doubles soumissions et conserver les saisies en cas de réseau indisponible.
5. La création d'entreprise dépend actuellement d'un paiement confirmé ou d'un accès offert par le fondateur. Le parcours d'essai nécessite un mécanisme explicite et idempotent.
6. Les offres fondateur, invitations, identités et licences gardent des liens avec les anciens utilisateurs. Une suppression dans Auth seule ne réinitialise pas l'application.
7. Les archives possèdent un déclencheur d'immutabilité. Une remise à zéro de test ne doit pas désactiver cette protection sur les données publiques.
8. Automation propose des fonctions prédéfinies, des réglages et un historique de décisions ; ce n'est pas un moteur universel de scénarios planifiés. Les déclencheurs et effets réels doivent être expliqués sans promettre des actions inexistantes.
9. La collecte serveur de mails reste en attente de l'autorisation précédente pour le planning Supabase ; elle ne peut pas être présentée comme permanente.

## Plan d'implémentation

1. Compte Supabase unique, erreurs explicites, confirmation/récupération et mutations sensibles avec nouvelle vérification du mot de passe.
2. Préférences persistantes, catégories de paramètres et arrivée guidée ; navigation à deux niveaux sur mobile, zones sûres iOS, commandes tactiles et réduction des animations respectée.
3. Gestion de l'abonnement par propriétaire et entreprise, à partir de Stripe ; affichage du prix, des droits réellement acquis, des dates et des conséquences d'une modification.
4. Automation intégrée au même espace, activation et historique liés à l'entreprise ; contrôles de concurrence et permissions conservés.
5. Suppression et réinitialisation : inventaire nominatif, sauvegarde privée vérifiée et répétition sur copie avant mutation distante. Auth, D1, Supabase, R2 et sessions locales doivent être rapprochés. Aucun effacement exécuté à ce stade.
6. Tests des parcours, accès croisés, rôles, concurrence et webhooks ; vérifications visuelles desktop et iPhone. Distinguer tests simulés, tests des services distants et tests physiques iOS.

## Décision externe attendue

Le choix entre environnement séparé et nettoyage des comptes de test du site public a été demandé. Sans périmètre certain, aucun compte, abonnement Stripe ou document distant n'est supprimé. Les paramètres globaux, secrets, migrations et modèles sont exclus du nettoyage.

## Références

- Apple Layout : https://developer.apple.com/design/human-interface-guidelines/layout
- Supabase gestion des utilisateurs : https://supabase.com/docs/guides/auth/managing-user-data
- Supabase déconnexion : https://supabase.com/docs/guides/auth/signout
- Stripe portail : https://docs.stripe.com/customer-management
