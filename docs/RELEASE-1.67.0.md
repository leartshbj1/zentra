# Zentra 1.67.0 — Entreprise partagée

Cette version remplace le simple transfert initial de la version 1.66 par une synchronisation continue de la base complète avec Supabase. Un administrateur active explicitement le partage dans Paramètres → Compte et équipe. Les invitations restent nominatives, limitées par la formule (titulaire compris) et soumises au rôle du membre. Le partage complet inclut les salaires et les données comptables ; ce périmètre est annoncé avant activation.

Les créations de devis et factures enregistrent le compte créateur. Le filtre « Créé par » permet de retrouver les documents de chaque personne. Aucun auteur n’est inventé pour les documents historiques.

## Fonctionnement et limites

Les révisions complètes sont privées dans Supabase Storage et Postgres. Le serveur contrôle la session, le membre, le rôle, la formule et l’entreprise à chaque requête. Les tables ne sont pas accessibles directement aux rôles anon/authenticated. Chaque fragment et l’archive complète sont vérifiés par SHA-256. La publication utilise une révision conditionnelle atomique ; une version concurrente ne peut pas écraser une autre version silencieusement. Les numéros de documents sont réservés par appareil via une procédure transactionnelle.

La synchronisation vérifie les changements toutes les 15 secondes lorsque l’application est active. Les envois interrompus sont conservés localement. La réception attend la fin de la saisie. La version complète impose une limite de 512 Mio par archive et 2 Gio de transport conservé par entreprise. Les dix dernières révisions terminées sont conservées, ainsi que les envois non terminés.

Il ne s’agit pas d’une fusion automatique des modifications concurrentes : si plusieurs appareils ont changé la base depuis la même révision, l’utilisateur conserve une sauvegarde locale avant de recevoir la version de l’équipe. Les changements non envoyés doivent ensuite être repris manuellement. Les données et fichiers originaux restent conservés avant ce choix explicite. Les clients 1.66 ne participent pas au partage continu et doivent être mis à jour.

## Validation

- Suite native : 707 tests réussis sur 710, un échec SQLite corrigé puis rejoué avec succès ; deux tests d’environnement ignorés. Les quatre nouveaux scénarios de collaboration ont été rejoués après la correction.
- Tests avec deux bases locales : documents et logo reçus, identité locale conservée, attribution du créateur, refus des écrasements et reprise des envois.
- Migration et procédures exécutées sur PostgreSQL de test : séparation des entreprises, permissions, fragments incomplets, révisions concurrentes, réservations de numéros et idempotence.
- Tests serveur : séparation des entreprises et des appareils, rôles, empreintes, reprise, rétention et chemins Storage privés.
- La migration de production a été appliquée et ses RLS/droits vérifiés le 14 septembre 2026. Aucun jeu de données client n’a été modifié.
- L’essai bout en bout avec deux comptes clients réels et l’installation physique Apple restent à vérifier. Les tests automatisés utilisent des données synthétiques isolées.

La disponibilité des exécutables et leur publication doivent être vérifiées séparément. L’IPA iPhone est non signé ; la version macOS publique utilise une signature ad hoc et une signature du mécanisme de mise à jour, sans notarisation Apple.
