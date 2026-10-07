# Revue indépendante du runtime US et du flux incrémental

Date : 8 octobre 2026. Revue locale en lecture seule du code et sondes avec des entreprises fictives. Aucun déploiement, appel à un moteur fiscal réel ou changement de production n'a été effectué. Ce document ne constitue ni une certification comptable ni une preuve de fonctionnement sur plusieurs appareils réels.

## Périmètre relu

- `lib/international/runtime-sync.ts`, `runtime-sync-store.ts`, `runtime-sync-server.ts` : contrat du flux, validation, pagination, application du delta et frontières HTTP.
- `lib/international/runtime-bindings.ts` : session, entreprise, siège, abonnement, vendeur public et absence volontaire de moteur fiscal de production.
- `lib/international/runtime.ts`, `erp-contract.ts`, `erp-request.ts`, `runtime-validation.ts`, `runtime-store.ts` : transitions, normalisation, revalidation et reconstruction des écritures.
- Tests runtime, synchronisation, HTTP et bindings. Lecture ciblée de `20261007224820_international_us_erp_delta_stream.sql` pour la reprise et les limites des pages ; pas de revendication d'un nouveau test PostgreSQL dans cette revue.

## Résultats reproduits après corrections

Les sondes ont utilisé les objets fictifs de `runtime-sync.test.ts`, chargés en mémoire. La première revue avait identifié cinq familles de défauts. Les reproductions finales confirment leur correction :

| Cas | Résultat observé |
| --- | --- |
| Changer le compte `sales` de `income` en `asset` dans un delta | Refus `ErpError: invalid_sync_state`. Le rapport source reste à `10000` unités mineures. |
| Altérer le plan comptable dès l'événement initial | Refus `ErpError: invalid_stored_state` contre le plan national explicite. |
| Porter le compteur des factures à `999` lors d'un paiement | Refus `ErpError: invalid_sync_state`. |
| Changer la date de début d'une période lors d'un paiement | Refus `ErpError: invalid_sync_state`. |
| Changer la configuration sans événement `refresh_configuration` | Refus `ErpError: invalid_sync_state`. |
| Ajouter `privateCredential` à l'en-tête du delta | Refus `ErpError: invalid_sync_state`. |
| Omettre `header.configuration` | Refus `ErpError: invalid_sync_state`, sans `TypeError` brute. |
| Remplacer un client par un objet incomplet avec `name: null` et `apiToken` | Refus `ErpError: invalid_request`. |
| Modifier le montant d'un paiement dans le JSON reçu après application | Le paiement du cache reste à `2500` unités mineures et son objet montant est figé. La facture antérieure conserve zéro paiement. |
| Ajouter un champ privé à la réponse de révision | Ce champ n'est pas conservé par la projection retournée. |

Le candidat est construit sans modifier le cache source, validé puis copié et profondément figé. Les factures émises ne peuvent pas être réécrites par le flux ; les paiements préexistants doivent rester un préfixe intact. Les écritures ajoutées sont reconstruites depuis leurs factures et paiements, et non simplement acceptées parce qu'elles sont équilibrées.

## Contrôles d'accès et reprise examinés

- Les bindings contrôlent l'entreprise exacte, la session browser ou device, l'appartenance et le siège effectif, puis l'abonnement actif. Un Bearer invalide ne bénéficie pas d'un repli sur la session du navigateur.
- Les handlers vérifient l'édition US et ferment le service lorsque les drapeaux d'activation sont absents. Les chemins CH historiques ne sont pas initialisés par ce runtime.
- Les erreurs HTTP et diagnostics examinés contiennent des codes et statuts, sans contenu financier ni jeton. Les réponses HTTP sont explicitement non mises en cache.
- Le flux exige des révisions contiguës. Un manque d'événement ou un cursor antérieur à la baseline SQL déclenche une récupération explicite du snapshot ; le client n'avance pas silencieusement au-dessus d'une lacune.
- La migration du flux limite les événements à 2 MiB et les pages à environ 4 MiB. La RLS reste activée et les RPC de lecture sont réservés au serveur ; la migration n'ouvre pas les données comptables à une publication Realtime publique.
- Le vendeur public est chargé pour l'entreprise exacte. Les secrets et URLs de logo courantes ne sont pas projetés. Une facture conserve les coordonnées publiques du vendeur et sa configuration historique.
- Le binding fiscal retourne actuellement `null` : l'émission nécessitant une détermination fiscale reste fermée, même si le statut de configuration est marqué configuré.

## Tests réellement exécutés

Commande exécutée après les corrections et après l'extraction des contrats partagés :

```powershell
node node_modules/vitest/vitest.mjs run lib/international/runtime-sync.test.ts lib/international/runtime.test.ts lib/international/runtime-server.test.ts lib/international/runtime-bindings.test.ts --maxWorkers=1
```

Résultat : **76 tests réussis**, quatre fichiers : synchronisation 25, runtime 31, HTTP 11, bindings 9. Les cas comprennent pagination/reprise, scope, refus d'accès, cas fiscaux fictifs, paiements, replays, revalidation de droits et protection du cache. La sonde indépendante a confirmé **zéro régression reproduite** parmi les cas auparavant acceptés.

## Limites et vérifications avant activation

Aucun nouveau bloqueur n'a été démontré dans ce périmètre après les corrections. Cela ne prouve pas l'absence de tout bug ni la capacité de production.

- Les tests HTTP/bindings simulent les fournisseurs et la persistance ; ils ne valident pas des sessions réelles contre PostgREST/D1/Supabase.
- Les tests SQL exécutés par le chantier backend et les contrôles UI/native doivent être consignés dans leurs livraisons respectives. Cette revue ne les annonce pas comme exécutés ici.
- La montée en charge, le temps de reconstruction d'un grand historique, les reconnections et conflits entre plusieurs appareils réels restent à mesurer. Un delta léger sur le réseau ne suffit pas à prouver un coût CPU faible de la validation complète.
- Un prestataire fiscal vérifié, des registrations/nexus validés et des preuves d'exemption applicables restent requis avant émission US réelle. Les métadonnées produit et l'évolution versionnée du fingerprint fiscal feront l'objet d'un chantier distinct.
- Le logo historique n'est actuellement qu'un emplacement de référence contrôlée. Son archivage immuable et son résolveur autorisé doivent être implémentés avant de prétendre conserver ou rendre son image historique.
- Les drapeaux d'activation, la migration versionnée et la validation staging doivent précéder tout pilote réel. Aucune conformité US GAAP, fiscale exhaustive ou certification réglementaire n'est revendiquée.
