# Action Engine — état de reprise

Objectif actif : un ERP qui prépare le travail administratif, avec contrôle utilisateur. Le développement US est mis de côté, sans suppression de ses sources ou preuves.

## Lot A0 terminé localement

- Audit de l’architecture et des raccords réels.
- Préparateur pur, contrats fermés, preuve source, catalogue, calculs exacts et orchestration sans effets de bord propres.
- 323 tests Action Engine/Automation passés, typage, lint et build réussis.
- Code : `bdc75b6404eb39d58bd5b509a3b53cffc8a29c5f`.
- Livraison : `CORE-VALIDATION-20261011.md` et `docs/evidence/action-engine-core-20261011.json`.

## Lot A1 terminé localement

- Registre D1 interne : propositions immuables, réservations permanentes, reçus terminaux et journal.
- Barrières SQL atomiques obligatoires, identité unique du devis, protection contre REPLACE et reprise après réponse perdue.
- Reçu adapté au véritable brouillon natif non numéroté (`quoteNumber: null`).
- 408 tests Action Engine/Automation passés, typage, lint, assets et build réussis.
- Code : `31483afb1a76d0c1c6705d47c9a870dddc545999`.
- Livraison : `DURABLE-VALIDATION-20261011.md` et `docs/evidence/action-engine-ledger-20261011.json`.
- Migration additive D1 0099 testée uniquement sur des bases locales. Aucune route ni écriture métier réelle activée.

## Lot A2 terminé localement

- Réservation durable avant analyse, tentative HTTP unique, résultat figé avant sauvegarde de proposition et reprise après accusé perdu sans nouvel appel modèle.
- Admission privée issue du véritable authentificateur appareil, limitée aux packs Complets Stripe actuellement payés ; consentement distinct, désactivé par défaut.
- 545 tests Action Engine/Automation passés, typage, lint, assets et build réussis.
- Code : `c3d92cce06ddff231522a1be2f19ba92b0aa9649`.
- Livraison : `INTAKE-VALIDATION-20261011.md` et `docs/evidence/action-engine-intake-20261011.json`.
- Migrations additives D1 0100/0101 testées localement uniquement. Ce prédicat d'autorité ne remplace pas les versions source/catalogue/client ni la preuve de publication ; aucune route activée.

## Lot A3 codé localement, validation native en attente

- Chargeur privé du ticket Support délégué et des ressources Gestion publiées ; codec ZIP/JSON fermé, empreintes des faits et relectures après attente.
- Identités connecteur enrichies et persistées même quand le texte ne change pas ; conversations multi-expéditeurs signalées. Les versions fournisseur ne déclenchent pas seules une nouvelle analyse.
- Sources natives d'un writer atomique client éventuel + devis brouillon non numéroté + reçu + audit + outbox ; projection depuis la copie SQLite figée, migration additive 62.
- Conservation des reçus avant réception/fusion, outbox locale exclue du partage, compatibilité v60/v61 préparée sur copies temporaires.
- **809/809 tests serveur**, typage, lint du noyau, format, assets et build passés. Le périmètre Support élargi conserve 29 diagnostics lint identiques à sa baseline.
- **50 tests natifs écrits, non exécutés**. Cargo check échoue avant compilation du projet : Windows App Control refuse les build scripts de dépendances, erreur 4551. Les lectures Rustfmt et revues statiques ne constituent pas une compilation.
- Code serveur : `b517d2d05ef843c44915804f8cf272da6a07dda5` ; code natif : `e7ae48848a529a368b238ac57f724f1c8aff10df` (`codex/action-engine-native`).
- Livraison : `NATIVE-PROJECTION-VALIDATION-20261011.md` et `docs/evidence/action-engine-native-projection-20261011.json`.
- Aucun IPC, endpoint Action Engine, déclenchement, notification ou déploiement activé. Une vraie archive produite par Rust n'a pas encore été passée au codec TS.

## Lot A4 codé et testé localement, désactivé

- Registre D1 permanent des publications, garde PostgreSQL permanente opt-in, CAS et fait service-only corroboré avant settlement. Une tentative pending bloque la progression Action Engine ; une clôture prouvée remplace une libération par simple expiration.
- Admission, source Support déléguée et publication composées dans les mutations D1 de préparation ; composition privée de l'intake et du fournisseur, sans route, déclenchement ou IPC.
- Reprises couvertes : accusé PG perdu, même opération, clôture/tombstone, ancienne copie de transport purgée côté commit serveur, retrait du flag et refus legacy même historique. Le `prepare` préalable natif reste à adapter.
- Régression : **1 256/1 256 tests**, 40 fichiers. Après correction finale du wrapper, **72/72** ciblés dont 14 PostgreSQL et cinq compositions PostgreSQL/SQLite ; ces cas recouvrent la régression. **14/14** tests unitaires supplémentaires du préparateur : **1 270 cas distincts** dans 41 fichiers. Typage, lint du noyau, format et assets réussis.
- Migrations additives D1 0102 et Supabase `20261011011348_action_engine_publication_coordination.sql` proposées et testées sur bases éphémères seulement. Allowlist vide ; consentement spécifique désactivé par défaut.
- Livraison : `PUBLICATION-VALIDATION-20261011.md` et `docs/evidence/action-engine-publication-20261011.json`.
- Code serveur : `a5c75c9830e9a291928447ba11deee22e3c9a664`. Build de production réussi, sans déploiement.
- La confirmation métier reste explicitement refusée : un catalogue publié ne prouve pas la présence d'un devis/reçu canonique. Les 50 tests natifs A3 restent non exécutés ; Windows App Control n'a pas été contourné ou retenté.

## Lot A5 codé et testé côté serveur, natif à valider

- Sonde de reprise authentifiée dans le transport collaboration existant, avant préparation/fusion : absence réelle, pending à reprendre avec le même commit, résultat committed historique ou annulation terminale corroborée. Aucune nouvelle tentative ni opération financière créée par la sonde.
- Une réponse perdue après réservation D1 mais avant PG peut progresser sans nouvelle archive ; un commit historique après purge permet de conserver la bonne référence de fusion. Pannes et schémas absents ne deviennent jamais une preuve négative.
- Sources natives : contrôles d'origine/génération/pending et des octets avant commit/confirmation, puis relecture de la tête. Les changements postérieurs au snapshot restent à publier. Lecture seule et acceptation distante gardent leur chemin existant.
- **1 365/1 365 tests serveur**, 43 fichiers, dont 95 nouveaux cas. Les 103 ciblés recouvrent ce total. Typage, lint du périmètre, format, assets et build réussis.
- **13 nouveaux tests natifs écrits, non exécutés : 63 avec A3.** Rustfmt a seulement parsé les deux fichiers A5 ; le blocage App Control 4551 n'a pas été retenté ou contourné.
- Code serveur : `db417589dfb0fa753688bef5180f3648c47ad547` ; code natif : `528d7f599327b6890ae87037306a931126182e14`.
- Livraison : `PUBLICATION-RECOVERY-20261011.md` et `docs/evidence/action-engine-publication-recovery-20261011.json`.
- Aucune nouvelle migration. Les schémas D1/PG A4 et le serveur A5 doivent être validés/installés avant distribution du client. Aucun déploiement, appel fournisseur ou changement de donnée client. La preuve métier du devis et sa confirmation restent à raccorder.

## Lot A6 codé et testé côté serveur, raccord privé restant

- Vérification de la vraie SQLite complète : client, devis, toutes les lignes, reçu et audit de création. Un audit/sidecar seul ne prouve rien ; modification, émission ou suppression avant première preuve impose une revue.
- Liaison provenance/réservation dans le même batch, journal canonique append-only et reprise historique après preuve durable sans dépendance au catalogue/tête/transport anciens.
- **1 524/1 524 tests serveur**, 47 fichiers ; **6/6** smoke des vrais modules sous Workerd. Typage, lint ciblé, format, assets et build réussis. Données synthétiques, aucune exécution Rust.
- **5 nouveaux tests natifs écrits, 2 enrichis : 68 avec A3/A5, non exécutés.** Rustfmt a seulement parsé les deux fichiers ; aucun Cargo/App Control retenté ou contourné.
- Code serveur `0e9330c7efaf143acf0998a96a251477b75a8d0b`, natif `3eee678aa16fc0eeb9f559232aa7a5ac66fb6453`.
- Migration D1 additive 0103 proposée/testée localement ; aucune nouvelle migration PG. Aucun endpoint, IPC, déclencheur, notification ou déploiement.
- Livraison : `CANONICAL-QUOTE-VALIDATION-20261011.md` et `docs/evidence/action-engine-canonical-quote-20261011.json`. Bornes du pilote, dépendance sql.js épinglée et absence de limite CPU stricte documentées.

## Lot A7 codé et testé côté serveur, raccord appareil privé

- Composition authentifiée privée : proposition/réservation/provenance relues, fait PG committed exact, métadonnées et tous les chunks/SHA vérifiés, vraie SQLite canonique puis journal de preuve avant confirmation du reçu.
- Reprise après accusé perdu sans ancien transport ni doublon. La preuve reste obligatoire avant tout rejeu de reçu ; révocation, intention US ou document altéré avant première preuve sont refusés.
- Course legacy fermée dans l'INSERT atomique et par la migration additive D1 0104 : aucune première preuve après un reçu concurrent, avec conservation du rejeu des preuves déjà acquises.
- **1 641/1 641 tests serveur**, 52 fichiers, aucun ignoré ; **117 nouveaux cas** par rapport à A6. Typage, lint ciblé, format, assets et build de production réussis. Le vrai plugin SQLite et son WASM sont également testés dans un contexte Node VM isolé.
- Code serveur : `d0f9a4cd5341882322378c8a7c22a7ff3832808c`. Aucune source native modifiée ; les **68 tests natifs restent non exécutés**, sans nouvelle tentative Cargo/App Control.
- Livraison : `DEVICE-CONFIRMATION-VALIDATION-20261011.md` et `docs/evidence/action-engine-device-confirmation-20261011.json`. Auth/PG/Storage explicitement synthétiques dans la composition locale : aucune preuve hébergée ou Rust revendiquée.
- Aucun endpoint, IPC, déclencheur Support, notification, appel JEV ou déploiement. Migration 0104 testée sur bases locales seulement ; aucun nouveau schéma Supabase.

## Lot A8 codé et testé côté serveur, réservation appareil privée

- Composition fermée source/proposition : acteur et installation issus de l'authentificateur, progression fraîche et provenance liée atomiquement avant input d'écriture privé. Les IDs métier restent choisis par le serveur.
- Classifieur de propriété sans divulgation d'une réservation d'autrui. Une preuve historique passe obligatoirement par A7 ; un reçu legacy ou une réservation non liée impose une revue. Une reprise sous contexte périmé ne fournit que les sélecteurs locaux, sans permission de créer.
- Dernière attente corrigée : progression complète et propriétaire exact sans reçu/preuve dans le même SELECT, sans lecture historique ultérieure sur succès. La garde à six paramètres maintient le vrai cas maximal sous 64 bindings, source JSON de 256 000 caractères comprise.
- **1 730/1 730 tests serveur**, 55 fichiers, zéro ignoré ; **89 nouveaux cas** par rapport à A7. Typage, lint ciblé, format, assets et build serveur réussis. Deux connexions SQLite et les vrais prédicats d'admission/source/publication sont testés localement ; aucun login, publication ou paiement hébergé n'est revendiqué.
- Code serveur : `23c32a5e6e0b2adda97f30d18e2837e61d6dbed8`. Six nouveaux fichiers TypeScript, aucune nouvelle migration ou source native modifiée. Les **68 tests natifs restent non exécutés**, sans nouvelle tentative Cargo/App Control.
- Livraison : `DEVICE-RESERVATION-VALIDATION-20261011.md` et `docs/evidence/action-engine-device-reservation-20261011.json`. Aucun endpoint, IPC, déclencheur Support, notification, appel JEV ou déploiement.

## Lot A9 codé localement, reprise et publication natives à valider

- Reprise privée du reçu/outbox par sélecteurs et origine locale, sans ancien mail ni plan. Hash de demande et audit de création recorroborés ; une absence ou incohérence reste incertaine, sans reconstruction ni nouvelle création.
- Writer receipt-first, puis refus d'un ancien pending/réception/conflit avant nouveau brouillon. Lien local version1 proposition/réservation → snapshot exact avant upload, ACK transport `base+1` distinct de la confirmation A7, archives retenues jusqu'à confirmation canonique.
- Première liaison exige les vrais faits initiaux de l'archive figée. Réception/fusion préservent le lien local ; export/import/changement d'entreprise le retirent. Restauration des liens publiés et nettoyage en présence d'orphelins corrigés. Le publieur doit correspondre à l'acteur/installation réservé.
- **1 805/1 805 tests serveur**, 56 fichiers, aucun ignoré ; **75 nouveaux cas SQL**. Typecheck et lint ciblé passés. Aucun code runtime serveur modifié ou nouveau schéma hébergé. Les essais Node exécutent les vrais SQL locaux ; ils n'exécutent pas Rust.
- **21 nouveaux tests Rust écrits, 89 avec A3/A5/A6, non exécutés**, sans nouvelle tentative Cargo/App Control. Version 1.90.15 et schéma partagé 62 conservés ; migration privée additive, aucune ancienne migration réécrite.
- Code natif : `d5f50f2e4eaa456d58a752b6caa049a6afcdf844` ; test SQL serveur : `e7b07c07c658eb653e51d75f0eef6e04fc44cc76`. Livraison : `NATIVE-RECOVERY-VALIDATION-20261011.md` et `docs/evidence/action-engine-native-recovery-20261011.json`. L'orchestration authentifiée, A7 natif, notification et déclencheur Support restent à raccorder après validation. Aucune activation ou publication de cette fonction.

## Lot A10 codé et testé côté serveur, acquittement natif à valider

- Contrat appareil fermé et synchrone pour les vrais A8/A7 ; handler interne POST/bearer, JSON UTF-8 de 2 KiB, refus des doublons échappés et erreurs bornées. Les refus d'abonnement/permissions ne deviennent plus une panne à réessayer. Aucun endpoint ou caller applicatif ajouté.
- Sources natives : lecteur historique des candidats, ACK canonique privé et marqueur immuable dans la même transaction que l'outbox confirmée. Un ACK de transport ou un reçu historique A8 sans snapshot ne suffit pas. Restauration ordonnée et nettoyage conservateur avec manifeste/SHA et vrais instants RFC3339.
- **1 976/1 976 tests serveur**, 59 fichiers, aucun ignoré ; 171 cas nouveaux. Un premier passage a eu deux échecs de préparation de fixtures anciennes ; le rapport est conservé, la relance complète inchangée seule passe. Typage, lint ciblé, format, assets et build de production réussis.
- **10 nouveaux tests Rust écrits, 99 cumulés non exécutés**, sans nouvelle tentative Cargo/App Control. Rustfmt parse seulement. Version 1.90.15, schéma partagé/sidecar62 et marqueur housekeeping A9 version1 conservés ; SQL privé de confirmation additive, aucune nouvelle migration hébergée.
- Code serveur : `0236918e88b6ae2a91f0f22cfc4ddee3ec396082` ; natif : `283cb84c4bafdb1b92e1375833697898a1162456`. Livraison : `DEVICE-BRIDGE-VALIDATION-20261011.md` et `docs/evidence/action-engine-device-bridge-20261011.json`. Consommateur authentifié complet, IPC, déclencheur Support, notification et validation native/staging restent manquants. Aucun déploiement ou appel fournisseur.

## Lot A11 codé et testé côté serveur, consommateur natif à valider

- Consommateur authentifié privé : origine compte/espace/membre conservée, vrais A8/writer/publication/A7/ACK, reprise d'un ancien pending avant écriture. Annulation protégée par garde détenue dans le worker/tâche ; candidats relus sous le même verrou compte avant publication concurrente.
- Le `confirmed` historique A8 transporte les quatre sélecteurs exacts de son vrai A7 ; ancien reçu seul refusé. Reprise après réponse perdue et publication ultérieure testée côté serveur, sans inférer la tête ni recréer de document.
- **1 982/1 982 tests serveur**, 59 fichiers distincts, aucun ignoré : 1 458 Action Engine et 524 adjacents, exécutés en deux cohortes. Typage sans cache incrémental, lint/format ciblés, assets et build réussis.
- **37 nouveaux tests Rust écrits, 136 cumulés non exécutés**. Rustfmt parse huit fichiers seulement. Aucun Cargo/App Control retenté ou contourné. Version 1.90.15 et schémas 62 conservés ; aucune migration nouvelle ou réécrite.
- Source serveur `804d5597b196cb709abcb74c49aa822c37c1d0fd`, native `ba69873c54ac24c4f87ece4505a32fe9541208b1`. Livraison : `DEVICE-CONSUMER-VALIDATION-20261011.md` et `docs/evidence/action-engine-device-consumer-20261011.json`. Aucun endpoint/IPC/caller Support/notification/opt-in ou déploiement. Compilation native, vraie archive interopérable et staging restent obligatoires avant activation.

## Lot A12 codé et testé côté serveur, découverte Support privée

- Reprise de la proposition immuable avant archive/catalogue/clé, sous droits actuels relus après les attentes. Résultat d'intake fini rejoué sans nouvel appel IA ; clé résolue seulement pour une vraie décision neuve après `start` durable.
- Découverte en lecture seule depuis les tickets persistés, indépendante du callback facultatif Support. IDs seuls, pagination liée au membre/espace/appareil, curseurs UTF-8 canoniques et relecture de la même page avant retour. Les intakes incertains ne sont jamais redispatchés ; ACK locaux perdus repris d'abord par l'outbox A11.
- Garde pays déplacé dans les fences partagés, sans doublon A8 ; pause Support pendant l'analyse bloque la progression fraîche. Migration D1 additive 0105 : index `(workspace_id, created_at, id)` seulement, testé par EXPLAIN local, aucun changement distant.
- **2 066/2 066 tests serveur**, 61 fichiers distincts, zéro ignoré : 1 542 Action Engine et 524 adjacents. 199 ciblés et 63 isolés recouvrent ce total. Typage, lint/format ciblés, assets et build réussis. Les échecs initiaux de fixtures et la relance complète à quatre workers sont conservés dans les preuves.
- Source serveur `13abea85ebe9fcc3454c70cd352ef78993fbb752`. Aucune source native modifiée ; **136 tests Rust toujours non exécutés**, sans Cargo/App Control retenté ou contourné. Livraison : `SUPPORT-DISCOVERY-VALIDATION-20261011.md` et `docs/evidence/action-engine-support-discovery-20261011.json`.
- Aucun endpoint/IPC/scheduler/caller Support/notification/opt-in ou déploiement. Une liste de travail n'est pas un droit de création ; le raccord applicatif et la validation native/staging restent obligatoires. Expéditeur structuré du connecteur API, supervision des intakes incertains et mesure de charge restent à traiter.

## Lot A13 codé et testé côté serveur, contrat de travail privé

- Handler et codecs fermés `discover`/`prepare` composant les vrais services A12. Réponses limitées aux IDs/résumés vérifiés entreprise/source/CHF/SHA ; aucun plan, prix ou autorité venant de l'appelant. JSON UTF-8 de 8 KiB propre au nouveau protocole ; limite d'exécution A10 de 2 KiB inchangée. `busy`/`uncertain` distincts, aucun retry modèle.
- Le connecteur Support API authentifié conserve désormais e-mail/nom/ambiguïté structurés facultatifs. Champs absents conservés, adresses multiples et formats `Nom <adresse>` refusés, aucune identité inventée depuis le corps. Changement d'identité seul persisté ; rejeu normalisé dédupliqué.
- **2 173/2 173 tests serveur**, 63 fichiers distincts, zéro ignoré : 1 597 Action Engine et 576 adjacents. 309 ciblés recouvrent ce total. Typage, lint/format ciblés, assets et build réussis. Les échecs initiaux de chargement fixture/runtime et de lint restent documentés.
- Source serveur `4f17e843b76e3de56fde86f9313161ee697c8d5c`. Aucune migration ou source native modifiée ; **136 tests Rust toujours non exécutés**, sans Cargo/App Control retenté ou contourné. Livraison : `SUPPORT-WORK-BRIDGE-VALIDATION-20261011.md` et `docs/evidence/action-engine-support-work-bridge-20261011.json`.
- Aucun endpoint/IPC/scheduler/caller Support/notification/opt-in ou déploiement. Décodage/orchestration natifs, lecture bornée des intentions locales et origine constante pendant toute la ronde restent à raccorder. Notification seulement après confirmation canonique et ACK local durable ; validation native/staging toujours obligatoire.

## Lot A14 codé, ronde native privée et reprise prioritaire

- Codec A13 Rust fermé, lecteur local de reprise sous mutex/IMMEDIATE et ronde privée de 20 sources par page, bornée à 10 000 sources. Une origine compte/espace/membre/installation unique est conservée pendant toutes les attentes ; le résumé/la reprise doit correspondre au SHA A8. Curseur en mémoire avancé seulement après la page entière, sans watermark permanent.
- Une revue a trouvé le TOCTOU de file vide pendant le réseau : le writer de production vérifie atomiquement l'absence d'outbox non confirmé après rejeu exact et avant création. Ancien wrapper multi-reçus réservé à `#[cfg(test)]`. Les reprises historiques restent possibles.
- **2 195/2 195 tests serveur**, 64 fichiers distincts, zéro ignoré : 1 619 Action Engine et 576 adjacents. Les 22 nouveaux tests exécutent les vrais SQL de sélection/garde sur Node SQLite, pas Rust. Typecheck sans cache, lint, format, assets et build production serveur réussis. Première erreur de format et relance ciblée conservées dans les preuves.
- **45 nouveaux tests Rust écrits, 181 cumulés non exécutés**. Rustfmt parse sept fichiers, sans compilation. Aucun Cargo/App Control retenté ou contourné. Version 1.90.15 et schémas 62 conservés ; aucune migration nouvelle.
- Source native `52e507e6abb93aa31214c795dae54ee8e5eb88cc`, test SQL serveur `50d9e3816254b49b5890fdfd318ad7cd6b5c4984`. Livraison : `NATIVE-WORK-ROUND-VALIDATION-20261011.md` et `docs/evidence/action-engine-native-work-round-20261011.json`.
- Aucun endpoint/IPC/scheduler/caller Support/notification/opt-in ou déploiement. Les compteurs de lot ne sont pas une notification durable. Compilation native, vraie archive interopérable et staging restent obligatoires.

## Lot A15 codé, historique confirmé privé et Journal facultatif

- Projection serveur issue du journal `receipt_confirmed` et des preuves canoniques/publications concordantes, sous droits et délégation Support actuels. Page fermée sans contenu privé, bornée et relue ; un autre appareil autorisé peut voir le fait historique sans posséder la réservation.
- Lecteur natif distinct des marqueurs A10, limité à l'acteur/installation locaux, mutex/IMMEDIATE et corroboration historique de chaque ligne/lookahead. Aucun schéma réparé ou document courant réinterprété. Les deux DTO/paginations restent distincts et exigent un adaptateur explicite.
- `AutomationJournal` accepte une page facultative, refuse les données étrangères/incohérentes, déduplique le rendu et transmet le `quoteId` exact à un callback facultatif. Quatre langues, clair/sombre, 18 captures web contrôlées. Aucun raccord Hub/WorkspaceApp/bridge, toast ou notification persistante.
- **2 242/2 242 tests serveur**, 66 fichiers : 1 666 Action Engine et 576 adjacents. **203/203 tests UI**, 13 fichiers ; les 53 ciblés sont inclus. Typage, lint/format serveur et builds web serveur/application passent. **8 nouveaux tests Rust écrits, 189 cumulés, zéro exécuté** ; Rustfmt parse seulement deux fichiers. Aucun Cargo/App Control retenté ou contourné.
- Sources serveur `4f3a453d34720698112755099179a33810de48d7`, native/UI `e0597c7c7aad451964d6cefe7025ebb896681d75`. Livraison : `CONFIRMED-ACTIVITY-VALIDATION-20261011.md` et `docs/evidence/action-engine-confirmed-activity-20261011.json`. Version 1.90.15 et schémas 62 conservés ; aucune migration, donnée réelle ou activation en production.

## Lot A16 codé, confirmations cohérentes et destination privée

- Contrôle des vrais instants RFC3339 dans la liaison initiale/rejouée et l'ACK transport ; date historique conservée au rejeu. L'ACK canonique recorroborre son candidat dans la transaction avant commit, pour ne pas conserver un marqueur que le lecteur refuserait après recul de l'horloge.
- Résolveur TypeScript privé du devis actuellement chargé : organisation, scope physique, nonce et identité admise ; absence/doublons refusés ; consultation en lecture seule ou après émission. Aucun raccord à WorkspaceApp/DocumentEditor, aucun objet ancien utilisé comme repli.
- **251/251 tests UI**, 14 fichiers, dont 48 nouveaux ciblés ; TypeScript application réussi. **5 nouveaux tests Rust écrits, 194 cumulés, zéro exécuté** ; Rustfmt parse seulement deux fichiers, sans modification. Deux revues statiques du natif sans défaut bloquant identifié. Le serveur n'est pas modifié ; les 2 242 tests A15 restent historiques, non relancés.
- Source native/UI `2851723ef4d5ddf0c0b76fa0938f2f55ecdc8f00`. Livraison : `CONFIRMATION-DESTINATION-VALIDATION-20261011.md` et `docs/evidence/action-engine-confirmation-destination-20261011.json`. Version 1.90.15 et schémas 62 conservés ; aucune migration ou activation.
- Audit hôte : ancien projet CircleCI retrouvé, mais reconnexion arrêtée à la vérification 2FA GitHub ; crédits/disponibilité actuels inconnus. Aucun push/job/Cargo, aucune saisie de secret ni contournement. La demande de vérification est laissée à l'utilisateur. La compilation native et le staging restent obligatoires.

## Lot A17 préparé, profil CI natif isolé non lancé

- Profil explicite `action-engine`, uniquement sur `codex/action-engine-native` avec verify-only, sans release/smoke. Les 53 workflows historiques refusent ce sélecteur ; les workflows génériques excluent aussi la branche réservée. Defaults, jobs et autres profils conservés.
- Plan pur issu du futur catalogue libtest compilé : **194 tests moteur + 44 régressions actives**, 33 filtres disjoints, deux tests process-kill ignorés explicitement exclus. Corroboration exacte des arguments, ordre, compteurs et zéro ignoré avant preuve distincte et retour avant packaging.
- **37/37 comportements synthétiques, 450/450 contrats AST, 16 000 combinaisons YAML** passent localement. Inventaire source réconcilié ; parse seul PS5.1 réussi. L'exécution des tests purs sous PS5.1 est refusée par ExecutionPolicy, sans contournement ; comportements exécutés sous PS7.6.5 seulement.
- Source native `3adcb83018280ef3d21953225cf72dada1659c94`. Livraison : `NATIVE-CI-VERIFICATION-20261011.md` et `docs/evidence/action-engine-native-ci-verification-20261011.json`. Runtime/version/schémas inchangés ; aucune migration, donnée réelle ou activation.
- **194 tests Rust toujours non compilés/non exécutés**, aucune exécution des 44 régressions natives ici, aucun push/job CI. La vérification GitHub 2FA et les crédits actuels restent non résolus. Aucun nouvel audit de connexion ou contournement App Control. L'interopérabilité ZIP complète et le staging restent à valider après la CI.

## Suite : premier vrai brouillon confirmé

1. Reprendre `AUDIT.md` et les contrats de `lib/action-engine/README.md`.
   Le raccord privé de réservation A8 est validé localement. A9/A10 ajoutent journal et primitives natives. A11 compose le consommateur authentifié ; A12/A13 ajoutent découverte persistée et contrat fermé ; A14 raccorde la ronde native dans les sources ; A15 prépare deux lectures historiques et le Journal facultatif. A16 ferme les incohérences de dates et prépare la destination courante. Aucune intégration native exécutée n'est revendiquée. Voir les rapports A11 à A16.
2. Valider les sources natives A3/A5/A6/A9/A10/A11/A14/A15/A16 sur un hôte autorisé : le profil A17 prépare compilation, 194 tests écrits et 44 régressions de restauration/fusion, mais n'est pas lancé. Valider ensuite l'interopérabilité d'une vraie archive synthétique complète. Ne pas retenter/bypasser Windows App Control en boucle.
3. Valider le protocole A4 sur un environnement de staging approuvé, notamment avec plusieurs connexions PG et le gateway complet ; la composition locale ne prouve pas une transaction distribuée. Tous les writers d'une entreprise protégée doivent suivre ce protocole, y compris après retrait de son flag.
4. Valider le raccord privé A14 de découverte/préparation au consommateur authentifié : reprise locale d'abord, pages puis nouvelle ronde sans curseur, origine constante et garde atomique. Après validation seulement, ajouter le caller Support/applicatif et la supervision des analyses incertaines. Un worker délégué ne fabrique pas d'identité appareil. L'identité structurée API n'est pas une preuve de propriété de la boîte.
5. Raccorder le writer privé validé à une commande native unique dans le desktop **1.90.15** de `app-current-corrections`, sous origine entreprise et contexte membre, admission/réservation/source distantes corroborées. Ne pas exposer directement l'input privé à la WebView.
6. Valider le consommateur authentifié A11 avant exposition : contrat fermé A10, réservation A8, journal A9 et lecteur/ACK A10. Son ACK transport ne confirme jamais l'outbox. Résoudre un ancien pending avant nouveau brouillon ; relire les candidats sous le verrou compte avant publication. `recovery_required` ne permet jamais de recréer. Tester commits perdus, modifications en cours, deux appareils, changements de compte et annulation pendant worker.
7. Après validation native/staging, raccorder les projections A15 à l’interface Activité / À suivre / Réglages avec un adaptateur explicite et le résolveur A16 du véritable devis dans l'entreprise autorisée, contrôlé juste avant ouverture. Ajouter l'état lu/notification durable dédupliquée seulement après confirmation canonique et marqueur local approprié ; le callback de l'aperçu ne prouve pas l'ouverture native.

Ne pas publier le desktop 1.46.1 de la copie serveur. Aucun changement de production n’a été effectué. Les ports abstraits ne constituent pas une intégration en ligne. L’objectif global n'est pas atteint ; l'activation reste bloquée jusqu'à validation native sur un hôte autorisé et validation du staging coordonné. Le blocage App Control 4551 connu depuis A3 n'est ni retenté ni contourné.
