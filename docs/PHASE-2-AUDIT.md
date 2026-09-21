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

## Réinitialisation exécutée le 21 septembre 2026

L’utilisateur a confirmé explicitement tous les comptes du site public, puis confirmé l’effacement définitif après présentation du résultat de simulation. Quatre comptes Supabase et quatre entreprises D1 ont été supprimés, avec leurs membres, invitations, licences, sessions, offres, données Support/Automation et sauvegardes actives.

- Sauvegarde administrative locale chiffrée AES-256-GCM, clé protégée DPAPI : 113 fichiers vérifiés. Elle reste hors des imports de l’application.
- Restauration D1 en mémoire : 88 tables, 274 lignes, 9 déclencheurs ; aucune violation de clé étrangère. Nettoyage répété sur cette copie : 40 instructions, protections restaurées dans la même transaction.
- Copie Supabase dans un schéma privé sans accès anon/authenticated : 51 tables, 812 lignes. Restauration temporaire vérifiée ligne par ligne, puis annulée. Migrations et paramètres conservés.
- Nettoyage réel : zéro utilisateur, identité, session, profil et espace collaboratif vérifié ; 9 objets R2 et 11 objets Supabase privés supprimés après contrôle SHA-256.
- 546 objets de distribution préservés. Configurations globales comparées à la sauvegarde ; 9 déclencheurs D1 inchangés.
- Réutilisation des quatre anciennes adresses testée via Supabase Auth, sans envoi d’e-mail : nouvelle identité, refus avant confirmation, connexion après confirmation, révocation après suppression. Comptes temporaires supprimés ; retour à zéro.
- Maintenance levée et `/api/auth/session` vérifié HTTP 200, `authenticated:false`. Anciens liens d’activation personnelle retirés. Route administrative temporaire retirée du code après l’opération.

La copie de récupération est réservée à l’administration. Les anciennes sauvegardes utilisateur ne sont plus prises en charge dans la version 1.77 : extension `.zentra` et manifeste version 2 obligatoires. Un simple renommage ne suffit pas.

## Validation et limites de cette livraison

Tests site avant finition : 92 fichiers, 1196 assertions réussies, 63 cas ignorés. Contrôles complémentaires des nouvelles mutations, du reset transactionnel et des confirmations PKCE ajoutés ensuite. Tests natifs de sauvegarde, de compte et de synchronisation exécutés dans CircleCI ; preuves de compilation et de démarrage conservées avec les artefacts de livraison.

Le parcours de courrier de confirmation n’a pas été validé avec une réception réelle lors du test de réutilisation. Les essais visuels iPhone utilisent un navigateur à dimensions mobiles ; ils ne constituent pas une installation sur un téléphone physique. La suppression autonome d’un propriétaire avec obligations de conservation et l’administration complète des notifications restent à traiter. Aucun planning de collecte permanente de mails n’a été activé.

## Références

- Apple Layout : https://developer.apple.com/design/human-interface-guidelines/layout
- Supabase gestion des utilisateurs : https://supabase.com/docs/guides/auth/managing-user-data
- Supabase déconnexion : https://supabase.com/docs/guides/auth/signout
- Stripe portail : https://docs.stripe.com/customer-management
