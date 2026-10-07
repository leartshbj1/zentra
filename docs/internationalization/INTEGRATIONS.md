# Abonnements et automatismes CH / US

Ce socle est **additif et non branché** dans le checkout `C:/Users/alb/Documents/ChatGPT/chantier`. Il ne modifie aucune route Stripe CHF, aucune licence native, aucun prix marchand et aucune ressource de production. Le checkout publié plus récent reste distinct : sa provenance est documentée dans [l'audit](audit-notes/billing-support.md).

## Catalogue SaaS et droits

`lib/international/subscriptions.ts` utilise la configuration nationale validée de l'entreprise. `resolveSubscriptionOffer(company, selection, trustedCatalog)` choisit une seule entrée serveur correspondant exactement au pays, à la devise, au module, à la formule et à l'environnement. Les modules sont Gestion, Support, Automation et Complet ; les environnements sont TEST et PRODUCTION. Aucun catalogue US ni prix par défaut n'est livré. Une entreprise US ne peut pas prendre un Price CHF en repli.

Une entrée décrit `catalogVersion`, `priceId`, `productId`, le montant entier en unité mineure, la périodicité et le comportement fiscal explicite. `verifyServerStripePrice` compare ces champs à un Price lu côté serveur : actif, produit développé actif et non supprimé, devise, montant exact, mode live/test, périodicité et prix récurrent fixe. Une réponse de prix valide n'est **pas** une preuve de paiement. Aucun taux fiscal ou tarif commercial US n'est inventé.

`subscriptionRights` consomme exclusivement une `SaasSubscriptionAuthority` chargée depuis l'autorité serveur. Son `SubscriptionEvidence` doit provenir soit d'un paiement vérifié, soit d'un essai autorisé séparément. L'organisation, la souscription, le mode, la version du catalogue, le Price et la devise doivent correspondre. La période est `[startsAt, endsAt)` ; une révocation ou une période expirée rend les écritures indisponibles. Un statut de cache `active`, une préférence de pays, une langue et une configuration fiscale n'accordent aucun droit. Un abonnement payé puis résilié conserve seulement sa période payée ; un essai exige sa propre preuve et le statut `trialing`. Complet couvre ses modules dans la même entreprise.

Le résultat `read_only` est une politique d'écriture, pas une autorisation de lire des données d'une autre entreprise : l'appartenance doit être vérifiée par le lecteur existant. Ces interfaces ne signent pas de licences et ne créent pas de périodes payées. Le futur adaptateur devra continuer à vérifier webhook, facture, espèces réellement encaissées, remboursements et conflits selon le moteur financier publié. Il ne doit jamais accepter une `SubscriptionEvidence` fournie par le navigateur.

`proposeSubscriptionPlanChange` conserve l'organisation, la souscription et les données, puis demande une confirmation du prestataire. C'est une proposition sans appel réseau. Elle permet les changements de formule au sein d'un module ; une fusion de plusieurs produits en pack exige l'orchestrateur de facturation existant et n'est pas simulée ici. Avant toute mutation financière, le consommateur doit vérifier le prix cible côté serveur, l'autorisation et l'exclusivité de la cible, figer les paramètres et conserver la même clé d'idempotence. Aucun nettoyage de données métier n'accompagne un changement de formule.

`BusinessInvoicePaymentProposal` décrit les encaissements des factures **de l'entreprise cliente**, avec une autorité marchande distincte. Il ne réutilise pas les credentials SaaS de Zentra. Les types ne contiennent ni clé bancaire ni numéro de carte brut. Les méthodes carte, ACH et virement sont des possibilités de contrat ; aucun prestataire d'encaissement client n'est connecté par ce module.

## Automatismes réutilisables

`lib/international/automation.ts` prépare trois workflows indépendants du pays : facture fournisseur, demande client et rendez-vous. `normalizeAutomationSource` accepte les libellés structurés EN/FR, conserve les textes originaux et refuse les champs inattendus ou ambigus. Pour une facture, les montants exacts net, taxe et total doivent déjà être fournis et cohérents dans la devise de l'entreprise. Il n'extrait ni TVA ni coordonnées bancaires à partir d'un texte libre et ne convertit aucune devise.

Pour un rendez-vous, le fuseau IANA est explicite et correspond à celui de l'entreprise. `resolveLocalMeetingTime` accepte les années 2000 à 2100 incluses et refuse les dates invalides, les heures inexistantes au passage à l'heure d'été et les heures ayant deux interprétations au retour à l'heure d'hiver. Le fournisseur doit corriger ces cas avant proposition ; aucune heure UTC ou suisse n'est choisie silencieusement. Le runtime cible doit disposer de la base IANA correspondant aux zones configurées.

Les ports injectés sont :

| Port                                      | Responsabilité du futur adaptateur                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `readAuthority({organizationId,userId})`  | Charger membre actif, rôle, entreprise, environnement, consentement et preuves actuelles depuis le serveur                         |
| `ClassificationProvider.classify(source)` | Classer seulement ; sa sortie est non fiable et validée avant toute proposition                                                    |
| `AutomationRunStore`                      | Persister une clé `(organizationId,requestId)`, préserver les empreintes et effectuer un CAS atomique sur la révision              |
| `readApproval(approvalId)`                | Charger une approbation serveur, liée au demandeur, à la proposition exacte, à l'entreprise et à une échéance                      |
| `sink.commit(...)`                        | Revalider atomiquement membre, droits, configuration et approbation dans la même transaction que l'effet ; appliquer l'idempotence |

`prepareAutomationWorkflow` exige un droit Gestion et un droit Automation actuels, ou un Complet unique couvrant les deux. Des preuves contradictoires sont refusées. Une facture fournisseur exige le rôle propriétaire, administrateur ou comptable ; un membre peut préparer les demandes et rendez-vous. Le consentement et le workflow activé sont nécessaires mais insuffisants pour accorder des droits.

La préparation fige l'entreprise, l'environnement, les droits, le consentement, le demandeur et la source dans une empreinte. Huit appels identiques concurrents peuvent reprendre la même ligne ; un autre contenu ne peut pas réutiliser son identifiant. La classification doit confirmer le type attendu avec une confiance d'au moins 0,9 ; une sortie douteuse reste `review_required`. Les actions proposées sont un brouillon de facture fournisseur, une demande client et un brouillon de rendez-vous. **Toutes demandent une validation humaine** ; une proposition financière ne paie ni ne comptabilise automatiquement la facture.

`commitAutomationWorkflow` relit les droits avant et après la réservation CAS, puis relit l'approbation avant l'effet. Le port reçoit `actorId`, `approvalId`, la proposition, l'empreinte d'autorité et une clé d'idempotence stable. Une dernière lecture seule ne remplace pas une barrière SQL : le vrai sink doit vérifier ces conditions dans sa propre transaction, ainsi que les références client/fournisseur de la même entreprise. Aucune implémentation de ce sink n'est livrée ici.

Une panne de classification permet un nouveau choix explicite `retryPreparation`, au plus trois tentatives avant effet. Une perte de réponse du sink devient `uncertain` et ne déclenche jamais un deuxième appel automatique. Les états `dispatching` interrompus et `uncertain` doivent être rapprochés avec une preuve du sink par un mécanisme opérateur distinct ; aucune expiration de verrou ne signifie « le paiement n'a pas eu lieu ». Le store réel devra également traiter les crashs durant `classifying`, sans reclasser silencieusement une opération déjà dispatchée. Aucun worker, ordonnanceur ou reprise opérateur de production n'est ajouté.

## Validation effectuée et limites

`lib/international/integration.test.ts` utilise des fournisseurs, approbations, effets et un store CAS **explicitement fictifs**. Il vérifie les contrats CH/US, l'absence de catalogue US implicite, les prix serveur, les droits expirés ou révoqués, la séparation des entreprises et environnements, les changements de formule sans suppression, les données EN/FR, les changements d'heure, les courses simultanées, les approbations et les réponses perdues. Tout appel `fetch` ferait échouer les tests.

Ces tests prouvent les politiques de la bibliothèque et ses ports ; ils ne prouvent pas une transaction D1/Postgres, un paiement, une licence mobile, une extraction de facture ou une livraison de message réelle. Jev/TypeSafe n'est pas présent dans ce checkout et n'a pas été raccordé. Aucun endpoint public, migration ou ressource externe n'a été ajouté. Le futur branchement devra se faire dans le checkout produit autoritaire, avec ses lecteurs de droits et ses protections financières, après recette des adaptateurs persistants et des permissions.
