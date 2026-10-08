# Zentra US — informations fiscales privées déclarées

Base : `cac89c2dd7ba84454026e1eb124ecab9ae3c874e`. Lot local additif, après le parcours vendeur. Le site commercial354, les données et distributions CH, les abonnements, les régions et les flags de production ne sont pas modifiés.

## Périmètre et autorité

Le propriétaire peut déclarer le nom légal, une adresse d'origine américaine et un fuseau IANA admis pour les États-Unis. L'adresse est validée structurellement (état, ZIP, champs et longueurs), pas géocodée ni vérifiée physiquement. Ce modèle ne détermine pas les autres établissements, les lieux de prestation, l'origine de chaque expédition, le nexus ou l'obligation de collecte. La saisie n'est pas une vérification fiscale.

Le statut enregistré est toujours `verification: 'unverified'`, que les informations soient absentes ou déclarées. Le resolver interne retourne uniquement un blocage et sa raison : informations nécessaires ou vérification du prestataire nécessaire. Il ne renvoie ni ces informations privées ni un grant d'émission. Aucun `configured` de la configuration nationale ne remplace cette preuve. Le fournisseur runtime reste `null`.

Cette séparation suit les prérequis documentés par Stripe : [Tax Settings](https://docs.stripe.com/api/tax/settings), [registrations](https://docs.stripe.com/tax/registrations-api) et [responsabilité de collecte avec Connect](https://docs.stripe.com/tax/connect). Il faut confirmer séparément le vendeur redevable et ses registrations applicables. Les ventes de l'entreprise cliente et l'abonnement SaaS Zentra restent des périmètres distincts. Ce lot ne crée pas de compte connecté, sandbox, registration ou calcul réel et ne confirme aucune situation juridique.

## Service et route

`GET/PUT /api/international/workspaces/[organizationId]/tax-profile` utilisent l'authentification existante, les droits propres USD/Gestion de l'espace et une configuration US/USD. Les deux opérations exigent le propriétaire ; les permissions de lecture ERP ou de comptable ne suffisent pas. Les secrets Supabase restent côté serveur. Le rôle et l'entreprise ne proviennent jamais du JSON ou de `user_metadata`.

L'enveloppe PUT contient seulement `expectedRevision`, `requestId` et `facts` versionnés. Les champs de fournisseur, de mode live, de registration, d'exemption, de vérification ou d'autorité supplémentaire sont refusés. Le service copie et fige les données avant les attentes, valide les réponses RPC contre l'organisation, l'acteur, la révision et le contenu exact, et conserve les microsecondes des timestamps PostgreSQL.

Le serveur recontrôle la configuration, le compte, le rôle, les droits et les flags après les attentes et juste avant l'écriture. Une révocation après commit masque le reçu ; elle n'efface pas l'opération déjà enregistrée. Une reprise exacte récupère le reçu historique, même si une révision plus récente existe. Le client doit relire le head courant avant de préparer une nouvelle modification. Les réponses sont `no-store` ; erreurs et diagnostics ne contiennent aucune donnée fiscale privée.

Les chaînes UTF-16 malformées sont refusées avec `422` avant le hook d'autorisation d'écriture et l'appel SQL. Les caractères supplémentaires valides, dont les emoji, gardent les limites de longueur existantes. Cette garde est limitée aux nouvelles déclarations privées ; les adresses et parcours CH ne sont pas modifiés.

L'autorité D1 et la transaction PostgreSQL sont distinctes. Les contrôles frais réduisent les fenêtres d'accès ; ils ne garantissent pas une révocation distribuée atomique entre ces systèmes. Cette limite reste à traiter et tester avant des effets fiscaux autonomes.

## Migration proposée

`supabase/migrations/20261008044402_international_us_tax_profile.sql`, créée localement avec `supabase migration new`, ajoute le head privé et son historique append-only. Révision CAS et UUID assurent des reprises exactes ; la transaction enregistre ensemble audit et head. Les contraintes et triggers empêchent une rupture de chaîne ou un reçu isolé. Le verrou suit entreprise → configuration nationale → head.

Les deux dates persistées doivent être finies et dans les années UTC 1 à 9999. Les trois projections de date (lecture, écriture et reprise) utilisent explicitement UTC et six chiffres de microsecondes : un changement de fuseau de session PostgreSQL ne change pas le reçu. La relecture a identifié et fait corriger ces deux limites du contrat temporel.

RLS et privilèges limités à `service_role`, fonctions `SECURITY INVOKER`, `search_path` vide, exécution retirée à `PUBLIC`, `anon` et `authenticated`. La base vérifie la configuration US et la chaîne ; elle ne connaît pas les membres D1 et ne constitue pas seule une autorisation propriétaire. Les profils CH ne sont ni copiés ni utilisés comme fallback.

La documentation Supabase actuelle a été consultée : [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [functions](https://supabase.com/docs/guides/database/functions) et les changements [Data API](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically) et [PostgreSQL15.19/17.11](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes). Les grants sont explicites ; les nouvelles tables ne supposent aucun accès automatique des clients. Le lot ne crée ni ltree, ni anciens chiffrements PGP, ni index GiST flottants, ni opérateurs personnalisés concernés par cette mise à jour. Aucune requête de diagnostic ou modification de production n'a été exécutée.

Retour arrière : garder les flags US fermés ou retirer les nouveaux branchements avant activation, en conservant tables et historique. Aucun DROP, backfill ou effacement automatique n'est proposé. Déployer ou modifier la production exige la recette staging et l'approbation explicite demandées dans la mission initiale.

## Fichiers

Créés : `lib/international/us-tax-profile.ts`, `us-tax-profile.test.ts`, `us-tax-profile.postgres.test.ts`, `us-tax-profile-server.ts`, `us-tax-profile-server.test.ts`, la route `tax-profile/route.ts`, la migration, ce rapport et `docs/evidence/us-tax-profile-20261008.json`.

Modifiés : `lib/international/runtime-bindings.ts`, son test et le manifeste attendu de `workspace-creation.integration.test.ts`. Aucun ancien SQL n'est réécrit. Les calculs, documents, QR et contrats financiers CH sont inchangés.

## Validation

Suite finale sur les sources gelées : **1 882 tests réussis, aucun échec, un test navigateur facultatif ignoré, 53 fichiers sélectionnés**. Le test navigateur n'a pas été demandé par son flag dédié ; ce lot ne change pas l'interface. La sélection couvre la suite internationale, PostgreSQL local activé, et les consommateurs CH ciblés compte, synchronisation/TVA, numéros de documents, contrats et webhooks Stripe, licences. Les trois nouveaux fichiers comprennent 173 tests du service, 61 HTTP et 100 PostgreSQL ; leurs résultats font déjà partie du total.

Les sept parcours supplémentaires HTTP → service → RPC PostgreSQL couvrent notamment la reprise d'un ancien reçu après un nouveau head, la réponse perdue, les révocations après commit et l'absence des informations fiscales privées dans l'état et les deltas ERP. L'émission reste refusée sans prestataire. Les dates hors plage, les projections dans trois fuseaux PostgreSQL et les caractères malformés ont été corrigés après relecture indépendante, puis inclus dans la suite finale.

TypeScript global, Oxlint sur les neuf fichiers TypeScript créés/modifiés, build Vinext et `git diff --check` : **exit 0**. Le build signale sa limite habituelle de classification statique de certaines routes ; ce n'est pas une validation des sessions hébergées. Les **131 fichiers SQL déjà suivis** à la base sont inchangés. Résultats structurés et empreintes : [preuve versionnée](../evidence/us-tax-profile-20261008.json) ; logs locaux sous `.qa/us-tax-profile/`.

Les scénarios locaux portent sur les déclarations privées, les droits propriétaire, les refus CH/autre entreprise, les reprises historiques, les conflits, l'atomicité locale, les privilèges et les données malformées. Les tests PostgreSQL utilisent PGlite local ; les tests HTTP ont une autorité synthétique. Ils ne prouvent ni deux connexions en concurrence, ni la durabilité après redémarrage/crash, ni PostgREST/D1 ou Auth hébergés, ni une registration, un calcul sandbox ou une conformité fiscale réelle. Ce lot ne constitue pas une recette des distributions natives, des QR-factures sur appareil ou de tout le fonctionnement suisse en production.

## Terminé et suite

Terminé et validé localement : persistance déclarative privée, admission propriétaire, historique et reprises exactes. Cette configuration reste expérimentale ; elle ne permet pas encore d'émettre une facture américaine via un prestataire réel et n'est pas un écran d'onboarding fiscal terminé.

Suite nécessaire : liaison fournisseur serveur vérifiée dans une sandbox distincte, snapshots datés Tax Settings/registrations, `ResolvedTaxRequestV1` comprenant quantités et codes fiscaux confirmés, dates/fuseaux, révisions privées et identité durable de l'opération. Registre idempotent, raisons de taxe zéro, outbox de transactions et corrections, limites des biens/livraisons, paiements, frontend et recette staging restent à livrer selon [US-TAX-PROVIDER-CONTRACT](US-TAX-PROVIDER-CONTRACT-20261008.md). Aucun tarif USD arbitraire ou activation globale n'est introduit.

Le prochain lot doit relier un parcours complet de devis accepté à une opération durable d'émission TEST, puis au calcul et au commit ERP avec sa preuve privée dans la même transaction. Le resolver de ce lot est réservé au réglage propriétaire et reste bloqué : ne pas fabriquer un rôle propriétaire pour un comptable, un administrateur ou un workflow. Un port interne d'émission doit conserver la permission financière réelle, l'espace et l'acteur autorisés tout en gardant les informations privées côté serveur.

Les projections actuelles de configuration et de vendeur ne portent pas leurs révisions PostgreSQL. La préparation et le commit de l'émission doivent donc lire et comparer les révisions persistées pays/vendeur/déclarations/proof sous un verrou adapté. Une comparaison d'objet public ou d'empreinte des montants seule ne remplace pas cette admission. Le compte sandbox et les résultats du prestataire devront être réellement vérifiés ; un gateway injecté ne fournit que des tests locaux.

Le formulaire propriétaire doit rejoindre le workbench US existant, séparé du profil vendeur public. Son statut sera « informations déclarées, non vérifiées », sans changement d'autorité fiscale lors d'une sauvegarde. Un reçu perdu pourra être repris seulement sous la même autorité fraîchement confirmée. Les données privées en mémoire doivent être purgées à la déconnexion, au changement de compte/espace ou à la perte du rôle propriétaire ; elles ne doivent pas être conservées comme les seules coordonnées publiques. Les autres rôles recevront une raison d'indisponibilité claire, sans accès à ces données.
