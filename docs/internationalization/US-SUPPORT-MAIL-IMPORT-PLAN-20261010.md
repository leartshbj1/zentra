# US Support H2b — import explicite vers les originaux fournisseurs

10 octobre 2026, base `1c2ba36`. La phase précédente constitue un progrès vérifié : connexion H2a, lecture explicite et preuves locales enregistrées. L'objectif ERP international reste ouvert. Cette phase raccorde les pièces PDF/PNG/JPEG aux originaux fournisseurs existants ; aucun déploiement, migration hébergée, traitement client réel ou changement CH.

## Parcours et droits

Un propriétaire/administrateur US disposant de Gestion et Support sur la même période consulte ses messages, choisit une pièce, confirme sa conservation et retrouve l'original dans Achats. Les rôles H2a restent inchangés ; le comptable conserve son accès manuel au coffre sans recevoir un droit implicite sur la messagerie. Automation, analyse, comptabilisation, acquittement mail, worker et quota d'inférence restent distincts et ne sont jamais déclenchés par cet import.

Gate nouvelle fermée par défaut : `INTERNATIONAL_US_SUPPORT_MAIL_IMPORT_ENABLED`, en plus de Mailbox/H1/Core/ERP et Supplier Documents, avec capacité comptable v4 effective et livre US/USD initialisé. La configuration de l'entreprise, l'identité, la session native, les droits et les gates sont relus autour des attentes. Aucun e-mail ni message ne choisit l'entreprise.

## Commande et provenance

Commande publique exacte : `{schemaVersion:1,requestId,connectionId,expectedMailboxRevision,uid,attachmentId,expectedMessageVersion}`. Aucun secret, octet, adresse, nom ou montant fourni par le navigateur ne sert de preuve source. Réponse : scope organisation/utilisateur/rôle/workspace, requête et empreinte, résumé d'original autorisé et indicateur de reprise.

Le serveur relit le détail brut via le transport Infomaniak partagé, exige l'UID amont complet `UID@folderId` conforme à la connexion capturée, puis vérifie un manifeste unique de pièces. Il ne réutilise pas le champ UID du helper legacy qui recopie la requête. Télécharger seulement l'endpoint fixe reconstruit ; aucune URL de pièce n'est suivie. Relecture du détail après téléchargement, comparaison de l'observation metadata canonique et SHA256 des octets. Taille 1 octet–6 MiB, MIME attendu par extension et signatures réelles, aucun ICS/HTML/ZIP. Si l'UID ou le manifeste est absent/ambigu/incohérent, refuser plutôt qu'inventer une provenance. La première adaptation est strictement Infomaniak ; elle reste injectable pour tests fictifs.

La documentation officielle ne fournit pas de UIDVALIDITY ni version de contenu forte. Cette procédure atteste des octets lus depuis l'endpoint sous cette connexion, pas une photographie atomique signée du mail. La clé source privée est entreprise + registre + fournisseur + mailbox/folder + UID + part, sans date/version/hash. Ces derniers sont des faits immuables comparés : une réutilisation/modification d'identité est un conflit, pas un nouvel import accepté silencieusement.

## Persistance et reprise

Migration D1 additive 0095 : sources, requêtes d'acteurs et confirmations, append-only. Le claim corrobore la vraie admission H1 et la connexion/révision courante. Les alias d'une même source conservent le premier identifiant d'original suggéré. Les reçus et confirmations historiques exigent toujours l'admission H1 fraîche mais ne dépendent pas de l'ancienne connexion ou clé. Limites pilote : 500 sources et 2 000 requêtes par entreprise.

Réutiliser le vrai store PostgreSQL d'originaux et R2 : lookup SHA256 privé, réserve PG immuable, PUT conditionnel, relecture des octets, confirmation PG, confirmation D1. Un petit RPC PostgreSQL additif de recherche par empreinte exploite l'unicité existante, sans nouvelle copie de texte/documents. D1, PostgreSQL et R2 ne forment pas une transaction unique ; chaque étape a un constat durable et une reprise, sans effacement compensatoire. Une réponse PG perdue retrouve l'original canonique par identifiant/empreinte. Un original déjà archivé peut être vérifié et finalisé sans relire le fournisseur ; un original manquant exige la connexion capturée encore courante. La confirmation D1 exige même entreprise, hash, taille, MIME et état PG stored, corroborés côté serveur par la relecture R2. SQL D1 ne prétend pas inspecter R2/PG.

Une connexion changée purge sélection et messages mais conserve l'import incertain sans secret. La perte Auth/espace/rôle/droits purge toute mémoire. Un 422 sur une reprise ne prouve pas l'absence d'effet d'un premier appel en vol. Le navigateur ne démarre pas une nouvelle demande à la place d'un résultat incertain. Le coffre et sa navigation reçoivent un rafraîchissement ciblé après confirmation, sans analyse automatique.

## Vérification et livrables

Tests contrat/D1 réel 0000–0095, RPC sur chaîne PostgreSQL locale peuplée de données CH fictives, fournisseur simulé avec UID réel/mismatch/manifeste changé/download borné, pannes à chaque frontière, réponses perdues, déduplication binaire/source/acteur, droits/gates/révisions révoqués pendant les attentes, absence d'effet financier/inférence/acquittement. UI réelle FR/DE/IT/EN, clair/sombre, mobile/ordinateur, confirmation/reprise/purge et actualisation du coffre. Typecheck, lint typé, marque, build et régression CH/US adaptée ; ne pas additionner les suites recouvrantes.

Retour arrière : fermer H2b puis revenir au code précédent, conserver les traces et objets. Toutes les migrations restent locales ; approbation explicite avant toute application hébergée. Livraison à huit rubriques et manifeste de commandes/résultats/empreintes. Les tests locaux n'attestent ni un fournisseur réel, ni D1/PG/R2 distribués, ni la conformité fiscale générale.

## Sources consultées

- Transport et données officiels Infomaniak : https://github.com/Infomaniak/mcp-server-mail/blob/main/src/mail-client.ts — UID retourné, ressources de pièces et endpoint fixe ; absence de version forte dans ces structures.
- Supabase RLS : https://supabase.com/docs/guides/database/postgres/row-level-security — tables privées sous RLS, grants limités et fonctions invoker.
- Changelog consulté : https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes — aucune nouvelle utilisation de ltree, btree_gist, chiffrement PGP legacy ou opérateur custom introduite ici. Aucun changement de version hébergée effectué.
