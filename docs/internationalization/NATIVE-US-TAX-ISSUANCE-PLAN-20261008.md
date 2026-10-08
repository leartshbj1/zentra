# Zentra US — prochain branchement fiscal et émission native

8 octobre 2026. Audit des sources en lecture seule, puis conservation de ce plan uniquement. Ce document ne branche aucun fournisseur, n'active aucune émission, ne modifie aucune clé, aucun flag, aucune migration ou donnée de production. Le lot natif achats/export reste distinct et figé.

## Bases et périmètre vérifiés

- Web : `D:/Codex-Zentra-Temporary/2026-10-08/international-site`, HEAD `3a0ca29844650578b311ebbdcd1c508c0288ddb5` lors du relevé.
- Natif autorisé : `D:/Codex-Zentra-Temporary/2026-10-08/international-native-admission`, HEAD `0ae57a5c0c2846e2245c943e0b6b059d47454392`, avec le lot achats/export présent dans son arbre de travail. Le HEAD seul ne constitue pas le gel de ces modifications non encore commitées.
- Les anciens clones, le dépôt original et les environnements hébergés n'ont pas été modifiés ou inspectés pour ce relevé. Les valeurs déployées des flags ne sont pas attestées ici.
- Les chemins et lignes ci-dessous correspondent aux sources lues à cette date. Ils ne sont pas une preuve de déploiement.

## Deux fermetures réelles

### 1. L'interface native ferme explicitement l'émission

`desktop/src/NativeUsWorkspace.tsx:37` passe `invoiceIssuanceAvailable={false}` à `InternationalErpPilot`. Le composant garde aussi `false` par défaut (`desktop/src/InternationalErpPilot.tsx:72`), ne montre l'action d'un devis accepté que si ce paramètre est vrai (`:133`) et conditionne le formulaire d'émission (`:147`). Le message de fermeture se trouve à `:135`.

Il ne s'agit pas d'un défaut de clic. Le bouton est volontairement absent tant qu'aucune disponibilité fiscale fiable n'est reliée.

### 2. Le runtime serveur n'installe aucun émetteur fiscal réel

`lib/international/runtime-bindings.ts:68` implémente encore `async taxProvider(){return null;}`. Le même objet n'injecte pas `issueInvoiceTest`. `lib/international/runtime-server.ts:32` offre pourtant ce hook privé ; `:108–110` choisit l'orchestrateur uniquement pour `issue_invoice` lorsqu'il est fourni, sinon conserve le moteur ERP générique.

Dans ce moteur, `lib/international/runtime.ts:183–184` refuse l'émission si le fournisseur manque ou si `taxConfiguration.status` n'est pas `configured`. Une modification isolée du booléen UI ne pourrait donc pas produire une facture utilisable. Elle supprimerait une information juste sans résoudre le blocage serveur.

Les flags `INTERNATIONAL_CORE_ENABLED` et `INTERNATIONAL_US_ERP_ENABLED` doivent être explicitement vrais (`runtime-bindings.ts:21`) ; leur absence ou l'impossibilité de lire les bindings ferme la fonctionnalité. Ce défaut sûr n'atteste pas leurs valeurs actuelles sur un site déployé.

## Ce qui est prêt, et ce que « prêt » ne signifie pas

| Surface existante | Comportement vérifié dans les sources | Limite restante |
| --- | --- | --- |
| `us-tax-profile.ts:23–49`, `:209–211` | Faits propriétaires versionnés ; état déclaré toujours `verification:'unverified'` ; résolution toujours `blocked`, avec `tax_details_required` ou `provider_verification_required`. | Sauvegarder le formulaire ne vérifie ni fournisseur, ni registration, ni nexus ; aucune émission activée. |
| `us-tax-profile-server.ts:16`, `:26–39`, `:63–73` | GET/PUT privés propriétaire, même autorité US que l'ERP, revalidation et reçu tardif masqué après révocation. | Aucun port privé fiscal natif ou activation fiscale ne découle de ce GET/PUT. |
| `us-tax-financial-context.ts:106`, `:150–171` | Lecture interne avec véritable rôle owner/admin/accountant, pays, vendeur, faits et binding révisés, contrôles avant/après les lectures. | Les empreintes et états ne remplacent pas une observation réelle du compte fournisseur. Les lectures composées ne sont pas un snapshot SQL atomique. |
| `us-tax-invoice.ts:21–38`, `:100` | Orchestrateur `executeUsTaxInvoiceTest`, gateway injecté `verify/calculate`, résolutions de classifications et lieu/date, reprise exacte et commit privé. | Aucun gateway réel installé par le runtime ; périmètre TEST uniquement, `allowTestFixtures` fermé par défaut. |
| `stripe-tax-resolved-request.ts:12–40`, `:237–253` | Entrées Stripe résolues, montants entiers exacts, classifications explicites, USD, services hors taxes et quantités entières. | Catalogue réel et applicabilité non observés ; aucun code fiscal ni taux à inventer. |
| `us-tax-operation-store.ts:27`, `:74–77`, `:95` | Registre durable, paramètres et clé provider exacts, réservation/calcul/commit/reçu, fenêtre de reprise initiale de 23 heures. | Pas de reprise automatique avec nouvelle clé, pas de garantie de récupération d'un 500 fournisseur, pas de durabilité hébergée démontrée. |
| `stripe-tax-sdk-body.ts` | Séparation du JSON métier et du `lastResponse` technique Stripe. | Des métadonnées SDK correspondantes ou absentes n'authentifient pas le compte, le mode TEST, l'origine ou les registrations. |
| `runtime-server.ts:108–110` | Point d'injection restreint à l'émission ; les autres commandes conservent leur moteur et leurs contrôles. | Hook non installé par les bindings existants. |
| `desktop/src-tauri/src/international_erp.rs:140`, `:567` | Commande native `issue_invoice` et passerelle ERP déjà présentes ; contrôle de requête et de reçu. | Pas besoin d'un deuxième livre, d'un nouveau bearer financier ou d'une finance recalculée en JavaScript. |

La migration existante `supabase/migrations/20261008060826_international_us_tax_operations.sql` contient les bindings privés (`:60`), leur historique (`:67`), les opérations (`:156`), les liens de preuve (`:386`) et le RPC `zentra_commit_us_tax_invoice_test` (`:470`). Elle conserve RLS et droits serveur (`:490–498`). Elle n'installe pas de fournisseur, ne change pas `taxConfiguration` et ne confère aucun droit financier (`:3`). Son existence et ses essais locaux ne prouvent pas son application à Supabase hébergé.

## Admission native : frontière à conserver

Le DTO connecté de `desktop/src/nativeAdmission.ts:45–46` confirme session, organisation, utilisateur, installation, rôle, abonnement, pays US, USD, échéances et capacité ERP. Il ne contient aucune disponibilité fiscale. L'identité, l'abonnement Gestion, `cap3` et le pays ne sont jamais un grant fiscal.

La passerelle de `desktop/src-tauri/src/us_admission.rs:956` utilise le coffre US et les routes fixes. Les vérifications d'origine/nonce avant et après l'attente, y compris en échec, sont déjà présentes (`:998–1040`). Le prochain port doit préserver ces garanties, HTTPS fixe sans redirection, contrôles bornés, aucun secret dans le WebView/log/URL et aucune attente réseau sous verrou.

Le mapper US `us_admission.rs:905` conserve les conflits CAS exacts avec statut 409 obligatoire. Les erreurs supplémentaires de fournisseur, binding, classification ou expiration devront être définies dans un prochain contrat US. Une erreur ambiguë ne doit pas libérer le pending ni autoriser une nouvelle clé ; le mapper CH ne doit pas être modifié pour ce branchement.

## Plus petite verticale suivante : TEST contrôlé

### A. Préparer une configuration fiable, sans fausse activation

1. Établir une sandbox vendeur contrôlée et distincte des abonnements SaaS Zentra. Vérifier réellement identité du compte, mode TEST, version API attendue, Tax Settings et correspondance de `head_office.address` avec l'origine déclarée, registrations et classifications applicables du catalogue.
2. Enregistrer uniquement côté serveur un binding versionné avec preuve d'observation et durée de validité. Ne pas transformer les faits propriétaires, une empreinte opaque ou un `test_fixture` en observation fournisseur. `allowTestFixtures:false` doit rester effectif dans ce parcours.
3. Réutiliser d'abord le formulaire fiscal privé propriétaire web existant, plutôt que créer un second éditeur natif. Les autres rôles financiers reçoivent seulement des motifs de préparation bloquée, jamais les faits privés du propriétaire.
4. Après vérifications explicites, traiter la préférence nationale `taxConfiguration.status` par le mécanisme de configuration versionnée existant. Le PUT `/api/international/workspaces/{org}/country` est propriétaire et CAS (`workspace-server.ts:97–119`). Puis exécuter `refresh_configuration`, propriétaire uniquement (`runtime.ts:25`, `:84`, `:96–99`), pour aligner le livre ERP. Aucun de ces deux changements n'est une autorité fiscale à lui seul.

### B. Brancher les surfaces serveur existantes

Injecter `executeUsTaxInvoiceTest` dans `erpServerDependencies.issueInvoiceTest` avec :

- `createUsTaxFinancialContextReader`, autorité fraîche réelle et horloge ;
- `createSupabaseUsTaxOperationStore` et le store ERP existant ;
- gateway réel `verify/calculate`, compte/environnement fixes résolus côté serveur ;
- `classifications(context,estimate)` confirmées et versionnées ;
- `transactionLocation(context,command)` pour le lieu billing/shipping et l'instant fiscal, cohérent avec la date de facture et le fuseau déclaré ;
- UUID d'opération et horloge côté serveur, `allowTestFixtures:false`.

Conserver le fournisseur générique `null` pour les organisations sans cette préparation fiable. Ne pas brancher un adaptateur superficiel sur le seul `buildTaxRequest` historique : ce chemin ne résout pas tout le contexte privé, le catalogue et le registre d'opérations du nouvel orchestrateur. Les autres commandes ERP et CH restent inchangées.

### C. Exposer une disponibilité fraîche puis l'utiliser dans le natif

Un **nouveau contrat à définir**, absent aujourd'hui, doit permettre une lecture publique de préparation fiscale liée à l'organisation sélectionnée et au véritable rôle. Séparer au minimum :

- préparation générale du vendeur/fiscalité ;
- capacité TEST de la portée prise en charge ;
- validation de la demande d'émission particulière.

L'état public pourrait distinguer `blocked` et `ready_test`, avec motifs bornés, révisions du contexte et limite de fraîcheur. Les noms et le schéma exacts restent à figer avant développement. Ne publier ni faits/adresse fiscaux privés, ni compte Stripe, registrations brutes, preuve fournisseur, clé ou bearer. Ne pas ajouter ce statut volatil au grant d'admission durable ni promettre que toutes les lignes de tous les devis deviennent émissibles.

Le port Rust doit rester une lecture énumérée sur route fixe, avec origine/nonce capturés avant/après succès ou échec. La UI ne remplace `invoiceIssuanceAvailable={false}` que sur cette confirmation fraîche, explicitement TEST. Les dates, périodes, lignes et révisions du devis sont toujours validées de nouveau dans le POST ; une readiness expirée ne peut jamais forcer l'émission.

Le parcours minimal devient : sélectionner l'espace US → préparation vendeur/fiscale propriétaire → confirmation TEST fournisseur → configuration et livre alignés → client/devis → devis accepté → revue de dates/période → émission TEST → reçu/delta → export de la facture. Les pages de configuration doivent expliquer le motif concret restant, sans détourner vers les réglages CH.

### D. Révisions, expiration et reprise

Les fences restent liés au même utilisateur, organisation, rôle, session et nonce. Le contexte d'émission conserve les révisions pays/vendeur/faits/binding/devis/ERP. Revalider pendant et après les attentes fournisseur, puis avant commit/réponse ; les guards SQL finaux restent nécessaires.

Une modification de faits, de vendeur, de registration, de classification, de compte ou de configuration ferme l'ancien contexte. Une limite de validité atteinte ne prolonge pas une preuve. Conserver les paramètres, la date, l'adresse, l'opération et la clé du fournisseur pour une reprise exacte autorisée ; la fenêtre de 23 heures ne doit pas être renouvelée artificiellement.

Un reçu engagé reste historique et peut être rejoué selon le registre durable. En revanche, une réponse refusée après commit ne prouve pas l'absence de facture : conserver le pending exact du même contexte et réconcilier. Ne pas transférer un pending vers une autre entreprise, ne pas créer une deuxième facture ou une nouvelle clé pour contourner un résultat incertain.

## Périmètre fiscal et exclusions à montrer clairement

La tranche actuelle accepte services, USD, prix hors taxes, quantités entières positives, maximum 100 lignes, classifications confirmées et destination US résolue. Elle ne constitue pas une table américaine exhaustive et ne calcule aucun taux localement en remplacement du prestataire.

Biens, exemptions client, prix inclusifs, quantités fractionnaires, lignes gratuites/entièrement remisées et réponses non représentables restent hors périmètre. Les motifs tels que `not_collecting` ou `not_supported` ne doivent pas devenir automatiquement une taxe zéro acceptée. Un zéro requiert sa preuve admise.

Une calculation n'est ni une Tax Transaction, ni une déclaration d'impôt, ni un paiement. Le moment fiscal de facture/paiement, l'outbox des transactions fiscales, les encaissements partiels, avoirs et reversals doivent être définis et validés séparément. La méthode cash/accrual du livre ne décide pas seule de l'obligation fiscale.

Toutes les interfaces/bindings d'orchestration et le RPC d'émission de cette tranche restent explicitement TEST. Une extension live doit faire l'objet d'un autre contrat, de types/guards adaptés, de migrations revues si nécessaires et d'une décision de déploiement ; un changement de flag n'est pas suffisant.

## Preuves et critères d'acceptation encore nécessaires

1. Calcul réel dans une sandbox vendeur contrôlée : compte/mode/API incorrects, adresse introuvable, origine différente, registrations actives/futures/expirées, catalogue et zéro admis/refusé.
2. Parcours HTTP réel avec session US protégée : devis accepté, calcul, preuve privée, commit atomique, reçu corrélé, delta, journal équilibré et PDF de facture. Aucun nouveau grant fiscal dans l'export ou le WebView.
3. Montants exacts/arrondis, remises, bornes numériques, 100/101 lignes, service non pris en charge et fuseau aux limites de date. Aucun taux inventé, facture/numéro/écriture partiellement persistés ou exemption implicite.
4. Révocation/session/rôle/souscription/flags modifiés pendant calcul, changement de vendeur/faits/binding/classification/ERP avant commit et après commit : pas de divulgation tardive et pending conservé en cas d'incertitude.
5. Timeout/429/500, réponse perdue, reprise exacte, expiration du calcul/de la fenêtre d'opération, crash et deux connexions PostgreSQL réelles en staging ; aucun nouveau calcul avec clé inventée, aucune deuxième facture.
6. Recette native sur un hôte capable de compiler/exécuter Rust, puis appareils/installations distincts. Le blocage Windows App Control `os4551` interdit de présenter les tests Rust écrits comme exécutés ou la preview comme une livraison native validée.
7. Revue fiscale/professionnelle du périmètre réel, de l'origine, des registrations/nexus, exemptions et événements de responsabilité. Aucune certification US GAAP, SOC 2 ou garantie générale de conformité n'est établie.

Le document antérieur `US-TAX-INVOICE-ISSUER-20261008.md:31–53` consigne des tests locaux du moteur/RPC/HTTP avec fournisseur et autorité fictifs, PGlite sérialisé en RAM et fetch Supabase synthétique. Ces résultats historiques ne constituent ni une observation Stripe, ni une recette PostgREST hébergée, ni une preuve de concurrence/durabilité ou de conformité. Aucun test n'a été exécuté pour le présent relevé.

## Fichiers concernés par un futur lot, sans modification actuelle

Serveur : `lib/international/runtime-bindings.ts`, le gateway réel à créer, les adapters existants `us-tax-invoice.ts`, `us-tax-financial-context.ts`, `us-tax-operation-store.ts`, `stripe-tax-resolved-request.ts`, `stripe-tax-calculation.ts`, `stripe-tax-sdk-body.ts`. Ajouter la readiness et son handler seulement après contrat exact ; ne pas improviser un grant via le GET privé des faits.

Natif : nouveau port US de readiness sous `desktop/src-tauri/src`, mapping US spécifique et tests, enregistrement IPC dans `lib.rs`, DTO/session de lecture fraîche côté TS et `NativeUsWorkspace.tsx`/`InternationalErpPilot.tsx`. Réutiliser la passerelle ERP pour l'émission et les exports US déjà présents. Ne modifier aucun corps de fonction CH ou ancien store d'entreprise.

Migrations : aucune nouvelle migration proposée ou exécutée par ce relevé. Les migrations fiscales privées existantes nécessitent revue, application staging, preuve et approbation explicite avant production. Aucun déplacement de données ou changement de région n'est prévu.

Retour arrière du prochain lot : retirer le hook/parcours, refermer les gates et conserver toutes les preuves, factures, reçus et audits engagés. Ne supprimer ni réécrire l'historique financier, ne rouvrir aucun fallback CH ni émettre sans preuve.

## Notes de sources exactes

Les deux racines absolues sont données en tête ; les chemins natifs ci-dessous sont relatifs à la racine native, les autres à la racine web.

- `desktop/src/NativeUsWorkspace.tsx:37` ; `desktop/src/InternationalErpPilot.tsx:72,133,135,147` : gate UI actuel.
- `desktop/src/nativeAdmission.ts:45–46,55` : DTO et identité du contexte natif, sans autorité fiscale.
- `desktop/src-tauri/src/us_admission.rs:905,956,998–1040` ; `desktop/src-tauri/src/international_erp.rs:91,140,567` : mapper, coffre/stamps et commandes existantes.
- `lib/international/runtime-bindings.ts:21,68,83` ; `runtime-server.ts:32,108–110` ; `runtime.ts:25,84,96–99,178–194` : flags, absence de fournisseur/hook, mise à jour et émission.
- `lib/international/workspace-creation.ts:43` : nouvelles entreprises US initialement `taxConfiguration.status:'unconfigured'`.
- `lib/international/workspace-server.ts:97–119` et `workspace-service.ts:112–140` : PUT country versionné, conservation des données privées existantes et reçu.
- `lib/international/us-tax-profile.ts:23–49,209–211` ; `us-tax-profile-server.ts:16,26–39,63–73` : faits privés et fermeture explicite.
- `lib/international/us-tax-financial-context.ts:93–112,150–171` : binding TEST/fraîcheur et lecteur réel ; `us-tax-invoice.ts:21–38,100,143–169,230–260` : orchestration/reprise/fences.
- `lib/international/stripe-tax-resolved-request.ts:12–40,216–263` ; `us-tax-operation-store.ts:27,74–77,95` : contraintes et clés durables.
- `supabase/migrations/20261008044402_international_us_tax_profile.sql` et `20261008060826_international_us_tax_operations.sql:3,60,67,156,386,470,490–498` : faits privés, registre, commit TEST et permissions.
- `docs/internationalization/US-TAX-PROFILE-20261008.md`, `US-TAX-PROFILE-BROWSER-20261008.md`, `US-TAX-PROVIDER-CONTRACT-20261008.md`, `US-TAX-OPERATIONS-TEST-20261008.md`, `US-TAX-INVOICE-ISSUER-20261008.md:27–29,51–53,73–81` : contrats antérieurs, limites et verrou de production. Les sources Stripe citées dans ces documents ne sont pas présentées comme une recherche réglementaire nouvelle effectuée pour ce relevé.

Livraison de ce lot : un fichier documentaire créé, aucune source métier modifiée, aucune migration proposée/exécutée, aucun provider ou réglage de production activé. Tests métier/Cargo : 0 exécuté pour cet audit ; la vérification de rédaction/diff ne constitue pas une validation fonctionnelle.
