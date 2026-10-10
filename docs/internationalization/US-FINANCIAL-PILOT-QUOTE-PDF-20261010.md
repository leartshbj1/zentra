# Pilote US V5 — PDF des devis — livraison locale

10 octobre 2026. Jalon du pilote privé US TEST validé localement, sans déploiement ni activation de production.

Code : `79cd604f090307ccb01bbe9c567001808f0d119d`, 21 sources/tests (3 créations, 18 modifications). Plan préalable amendé avant réparation : `docs/internationalization/US-FINANCIAL-PILOT-QUOTE-PDF-PLAN-20261010.md`, base `d5002428594890f8623a3eae8105e06f8edbd1f1`.

Preuve corrélée : `docs/evidence/us-financial-pilot-quote-pdf-20261010.json`, SHA256 `86761afdbbfb23c00853e16abc88a61735e7faca2032d3edcbd1e5a7dcef9f33`, inventaire de 2161 artefacts. Les contrôles, revues, navigateur et commit code correspondent au même arbre de 3650 fichiers : `d2e852f987565b15cbcf8774760b39934b0a7ceb0dda23a637a2c98bddb5e69c`.

## 1. Résumé des modifications

Le détail d'un devis enregistré du pilote US permet de télécharger son PDF US Letter en français, allemand, italien et anglais. Le document restitue toutes les lignes, quantités, remises, notes et les totaux exacts avant sales tax à la révision E du devis dans le livre financier F. Il conserve le client enregistré dans le devis jusqu'à une modification explicite de celui-ci. Le vendeur est le profil courant à l'export, avec versions distinctes C de configuration et S de profil, et une notice qui explique cette différence.

L'action est une lecture : elle n'accepte pas le devis, n'émet aucune facture, n'encaisse rien et ne crée ni journal, reçu durable, e-mail ni historique documentaire. Les anciennes branches facture/rapport et leur builder à deux arguments sont conservés ; le nouveau devis utilise un builder privé explicite à trois arguments. Aucun CSV public de devis n'est ajouté.

Le téléchargement observe le propriétaire financier réel, son état ready, F, les mutations, pending et dettes financières. Les changements de session, propriétaire, tenant, devis, langue ou onglet, ainsi qu'une révocation, annulent les résultats et purgent les URL. Un flight synchrone empêche les doubles départs sans verrouiller les écritures financières. L'avancement bancaire externe B seul ne périme pas un devis lorsque F est inchangé.

Le binding lit le head vendeur par sélection privée exacte sous pleine admission du pilote. Le RPC legacy reste fermé `PU008` après promotion V5. Le PostgreSQL actuel fige les heads pays/vendeur après promotion : le profil réel est corrigé avant promotion dans la recette, puis relu sans permettre de le modifier. Les changements C/S pendant les attentes sont des scénarios distincts de handlers mémoire, sans prétendre autoriser une édition PostgreSQL postpromotion.

## 2. Fichiers créés

| Fichier | Résultat |
| --- | --- |
| `lib/international/us-financial-pilot-quote-identity.ts` | Identité privée fermée, capture détachée C1→S→C2, validation et lecteur exact du head vendeur. |
| `lib/international/us-financial-pilot-quote-identity.test.ts` | Captures hostiles, permissions renouvelées, versions, données vendeur et sélection privée. |
| `app/api/international/workspaces/[organizationId]/financial-pilot/exports/estimates/[estimateId]/route.ts` | Route GET mince vers ESTIMATE. |

La preuve JSON suivie est livrée séparément du commit code. Le harness, logs, rapports, copies PDF, rasters et revues détaillées restent dans `.qa/us-pilot-quote-pdf/`, ignoré et inventorié par SHA. Ils ne constituent pas de nouvelles routes ou données de production.

## 3. Fichiers modifiés

| Fichier | Résultat |
| --- | --- |
| `lib/international/us-financial-pilot-export-contract.ts` | Selector PDF devis fermé, metadata E/C/S, faits, sections, totaux et budget UTF-8. |
| `lib/international/us-financial-pilot-export-contract.test.ts` | Schémas, arithmétique exacte, corrélations, captures hostiles et anciennes branches. |
| `lib/international/us-financial-pilot-export-projection.ts` | Snapshot du vrai replay V5, devis historique et identité privée courante. |
| `lib/international/us-financial-pilot-export-projection.test.ts` | Client historique/resave, émetteur courant, versions et livres mixtes. |
| `lib/international/us-financial-pilot-export-server.ts` | ESTIMATE, admission renouvelée, fences et headers corrélés. |
| `lib/international/us-financial-pilot-export-server.test.ts` | HTTP fermé, délais, absence/changement d'identité, révocations et refus sans fichier périmé. |
| `lib/international/us-financial-pilot-export-bindings.ts` | Lecteur privé seller exact avec lecteur country sous pleine admission ; aucun appel au RPC vendeur legacy. |
| `lib/international/us-financial-pilot-export-bindings.test.ts` | Capture des ports, route et sélection privée. |
| `lib/international/us-financial-pilot-exports.postgres.test.ts` | Recette cumulative34, vendeur avant promotion, refus postpromotion, conservation des faits et clean reopen. |
| `lib/international/us-financial-pilot-export-renderer.ts` | PDF devis Letter, parties sur deux colonnes avec fallback paginé, copie/totaux propres et refus CSV devis. |
| `lib/international/us-financial-pilot-export-renderer.test.ts` | Vrais PDFs quatre langues, une page pour les devis courts, texte/glyphes, remises, notes et 101 lignes. |
| `lib/international/us-financial-pilot-export-copy.ts` | Libellés et notices documentaires FR/DE/IT/EN. |
| `lib/international/browser-us-financial-pilot-export-session.ts` | Transport devis, owner réel, invalidation et adoption/téléchargement protégés. |
| `lib/international/browser-us-financial-pilot-export-session.test.ts` | Vraies session/handlers/kernel, réentrance, pending et distinction B/F. |
| `lib/international/browser-us-financial-pilot-export-copy.ts` | Actions et récupération ciblée pour profils absents/changés, limites et erreurs. |
| `components/account/us-financial-pilot-export-actions.tsx` | Variante devis, flight synchrone, lifecycle et feedback du propriétaire courant. |
| `components/account/us-financial-pilot-commercial.tsx` | Action du détail enregistré, montage sur l'onglet devis et conservation des formulaires. |
| `components/account/us-financial-pilot.tsx` | Transmission de l'utilisateur attendu et du callback de refus d'accès à la branche commerciale. |

L'inventaire exact et les 21 hashes sont corrélés au commit code dans la preuve JSON. Aucun CSS, moteur financier général, dépendance ou font n'est modifié.

## 4. Migrations proposées

Aucune migration nouvelle, aucun RPC nouveau et aucune modification SQL. Aucun changement de production, abonnement Stripe, effacement ou déplacement de données.

La recette PostgreSQL utilise 34 migrations déjà livrées : la chaîne antérieure32 et les ajouts existants `20261010131903_international_us_financial_pilot_invoice_dto1` et `20261010155848_international_us_financial_pilot_bank_test_v1`. Les anciennes recettes, aliases et preuves restent préservés avec restauration des octets historiques et vérification des hashes. Le lecteur privé ne retire ni trigger, guard, grant ni politique RLS.

Retour arrière : retirer/fermer l'action ou la route ESTIMATE, ou fermer les gates TEST, en conservant livres V5, documents, reçus et exports antérieurs. Aucun retour ERP4 ni effacement financier n'est nécessaire.

## 5. Tests exécutés et résultats

Les quatre contrôles quality-v6 ont réussi sur l'arbre final exact, inchangé avant/après chaque commande :

| Contrôle | Résultat | Preuve sous `.qa/us-pilot-quote-pdf/` |
| --- | --- | --- |
| TypeScript `tsc --noEmit --incremental false` | exit0, 28958ms | `types-quality-v6-command.json` et log |
| Oxlint type-aware, deny-warnings, 21 sources | exit0, 1557ms | `lint-quality-v6-command.json` et log |
| Marque | exit0, 451ms | `brand-quality-v6-command.json` et log |
| Build vinext | exit0, 19681ms | `build-quality-v6-command.json` et log |

| Vérification | Résultat corrélé |
| --- | --- |
| Ciblés `targeted-v3` | 412/412 réussis, 8 fichiers, 65611ms ; aucun échec, pending ou todo. |
| Régression sélectionnée `regression-final` | 6903/6903 réussis, 204 fichiers, 833651ms ; aucun échec, pending ou todo. Les 203 fichiers précédents sont conservés, avec le test d'identité ajouté. |
| PostgreSQL cumulative34 | Recettes targeted-v3 et regression-final : 10 invariants réussis, F16/L7/B3/C2/S2, export sans effet, profil vendeur corrigé avant promotion, refus legacy et corrections/no-op postpromotion préservés, fermeture puis nouvelle instance NodeFS et reprise exacte. |
| PDF renderer | FR/DE/IT/EN : devis courts d'une page Letter, texte/glyphes sans débordement ; devis allemand de 101 lignes sur 8 pages. |
| Revue visuelle PDF | 2 planches, 7 pages échantillonnées de 5 PDFs : 4 devis courts et pages 1/2/8 du document long. Parties, remises, montants, totaux et notes lisibles ; aucun constat bloquant. |
| Navigateur local5389 | 26 vérifications réussies, 0 échec ; 16 vues DOM quatre langues × deux thèmes × desktop/mobile. Navigation, purge, refus après changement C/S, profil absent/restauré et révocation vérifiés. |
| Captures UI revues | `quote-en-light-1280.png` et `quote-fr-dark-390.png` : actions lisibles, empilement mobile dans la largeur et surfaces distinctes sans collision visible dans ces fixtures. |
| Tentatives HTTP devis | 8 terminées : `200,409,200,409,200,409,200,401`. Toutes conservent les marqueurs financiers/bancaires avant/après ; 4 PDFs réussis, headers/longueurs/SHA corrélés. |
| Téléchargement UI réel | `browser/downloaded-quote-en.pdf`, 21769 octets, SHA256 `732b5dcd5f3fa1362de2b1ce421b598192a7deacab0b7e6a9642dc0f92ffb786`, égal à la tentative serveur1. L'API d'événement a expiré ; le fichier enregistré a été vérifié indépendamment. |
| Assemblage final | Réussi après le commit code : sources, commandes, 204 fichiers sélectionnés, restaurations historiques, 34 migrations, 4 domaines de revue, preuves navigateur, téléchargement et PDF corrélés ; 2161 artefacts SHA inventoriés. |

Les nombres ciblés/régression se chevauchent et ne sont pas additionnés. Les rapports et commandes exacts sont référencés dans `validation` de la preuve JSON, avec leurs SHA. Les deux recettes PG vérifient la stabilité de leur propre livre et registre ; leurs hashes ne sont pas supposés identiques entre exécutions indépendantes.

La régression conserve notamment `lib/business-sync-cash-vat.test.ts`, `lib/document-number-reservations.test.ts`, `lib/international/legacy-country-guard.test.ts` et `legacy-country-guard.migrations.test.ts`, ainsi que les tests de compte/espaces, Supabase Auth, contrat Stripe, langues et Support. Il s'agit des scénarios de compatibilité sélectionnés du site/runtime. Aucun test de génération de QR-facture suisse ni exécution de l'application native suisse n'a été réalisé dans ce lot ; ces résultats ne valident pas à eux seuls toute la TVA, paie ou comptabilité CH. Aucun code CH ni abonnement existant n'est modifié par le commit21.

Les quatre domaines de revue statique couvrent les 21 sources : contrat/projection4, backend8, navigateur3 et renderer/copie/UI6. La revue backend finale v4 a le SHA `8f79b1e1ff05ecb67130066bb4dd3efd045790b48c32e8401825ed6ce2345d2c`, sans constat bloquant. Les quatre sources UI/copie inchangées sont corrélées à la revue v2 et les deux renderer à la revue v3. La revue visuelle PDF est liée au SHA du renderer final et aux 412 tests ciblés.

Historique conservé : quality-v3/v4 réussis sur des candidats antérieurs ; lint-v5 refusé sur la fixture `String(input)`, puis réparé dans le test seulement ; targeted-v1 385/393 et targeted-v2 386/393, suivis du diagnostic `PU008`, de l'amendement préalable et du lecteur privé. Diagnostic-v3 n'avait exécuté qu'un cas réussi et 17 non exécutés, avant la passe entière. Le défaut visuel initial des notes orphelines est corrigé et vérifié sur les rasters finaux. Les tentatives/logs restent archivés séparément, sans réécriture des échecs en réussites.

## 6. Risques identifiés

- Les lectures C1→S→C2, postflight et admission renouvelée ne constituent pas une transaction atomique F+C+S+Auth/D1. Elles ne prouvent pas qu'aucun changement ne surviendra après la dernière observation.
- Les heads pays/vendeur restent figés après promotion PG. Les changements C/S pendant les attentes sont vérifiés sur sources mémoire contrôlées ; aucune édition PG postpromotion n'est activée ici.
- Le plafond JSON devis de 2097152 octets UTF-8 est appliqué après capture structurelle. La capture borne valeurs/nœuds/profondeur, pas l'allocation des noms de propriétés ; aucune borne de mémoire avant capture n'est revendiquée. Aucun snapshot JSON n'est accepté dans un body public.
- Les plafonds documentaires restent 1000 lignes, 500000 caractères, 200 pages et 12MiB de sortie. Un glyphe non couvert est refusé, sans substitution silencieuse. Les extrêmes ne promettent pas un temps constant.
- Le harness boucle locale sérialise les requêtes ordinaires ; Auth/D1/pays/vendeur et observations fiscales y sont synthétiques. Les vrais handlers, sessions, kernel et renderer sont utilisés, mais ce n'est ni une preuve de charge, de concurrence DB ni de disponibilité hébergée.
- La reprise PG démontre une fermeture propre et une nouvelle instance NodeFS, pas une récupération après crash ou une course multiconnexion.
- `waitForEvent` téléchargement a expiré. La preuve du fichier réel repose sur sa longueur et son SHA indépendamment vérifiés ; aucune réussite de cette API n'est revendiquée. L'adaptateur Vite ne propage pas le disconnect HTTP à Request.signal ; seule l'absence d'adoption UI périmée est démontrée côté navigateur.
- La revue humaine porte sur deux captures UI et sept pages PDF échantillonnées, pas chaque écran ni toutes les pages du document long. Le build conserve un avertissement d'analyse statique vinext ; un build réussi n'est pas une exécution hébergée des routes.
- Aucune validation native Windows/macOS/iOS/Android, Auth/D1/PG hébergée, fournisseur réel, résidence des données ou conformité juridique/fiscale n'est réalisée. Aucune certification US GAAP, SOC2 ou garantie de production n'est annoncée.

## 7. Fonctionnalités terminées

- Selector estimate/pdf fermé, ID/E/F sûrs, metadata C/S et bases explicites `current_at_export` / `before_sales_tax`.
- Vrai replay V5, client historique jusqu'au resave et vendeur courant capturé ; aucune identité tirée d'une autre facture ou du contexte fiscal marchand.
- Calculs déterministes de quantités, remises par ligne en points de base et totaux subtotal/discount/net sans flottants financiers.
- Identité privée par sélection exacte du tenant, validation fermée des données/audit et pleine admission autour des attentes ; profils absents, hostiles ou périmés refusés.
- GET ESTIMATE borné, headers E/C/S, digest du selector/contenu et nom déterministe `zentra-estimate-r<F>-e<E>-<lang>.pdf`.
- PDF Letter quatre langues, toutes lignes/notes/remises, état et trace de révision ; aucune taxe US inventée ni QR-facture CH ajoutée.
- Session d'export liée à l'owner financier réel : flight, deadline, flux, digest, annulation, purge, refus des résultats forgés et distinction B/F.
- Action dans le détail du devis enregistré, conservation des formulaires/pending commerciaux et feedback du propriétaire courant.
- Anciennes branches facture/rapport conservées ; exports/refus sans modification des livres, journaux, reçus, pièces émises ou complétions bancaires, avec reprise locale vérifiée.

## 8. Fonctionnalités expérimentales et prochaine priorité

Le jalon reste un pilote privé US TEST. Aucune activation de production, archive légale, calcul fiscal de devis, signature, acceptation externe, envoi d'e-mail, CSV public de devis, provisioning Stripe ou mise à jour native n'est livrée. La résidence des données et les traitements réglementaires complexes requièrent des validations externes distinctes.

La prochaine priorité est une verticale de maintenance **du nom d'affichage et des contacts du vendeur après promotion**. Elle doit être planifiée séparément avec autorisations du pilote, révisions explicites, historique, idempotence et préservation des identités figées dans les factures déjà émises. Les refus postpromotion actuels ne doivent pas être contournés.

L'adresse, le pays, la devise, l'origine fiscale et les paramètres de taxe restent distincts de cette maintenance d'affichage/contact : leur modification n'est ni implicitement autorisée ni couverte par ce futur périmètre. Le CSV de relevé n'est pas la priorité suivante de cette livraison.
