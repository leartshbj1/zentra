# Zentra US — raccord de facturation du pilote financier V5

Date : 10 octobre 2026. Plan avant développement, base `398a9d2`.

La tranche précédente constitue un progrès vérifié : le parcours client → devis → acceptation interne est enregistré dans le même livre V5, avec sa recette locale et ses preuves. L'objectif ERP US complet reste actif. Ce plan poursuit maintenant ce parcours jusqu'à la facture et son écriture comptable, sans ouvrir la production ou modifier les espaces CH.

## Parcours et architecture

1. Depuis un devis accepté courant, choisir les dates de facture, d'échéance et de comptabilisation, une période ouverte et l'adresse fiscale pertinente. Confirmer une classification de service pour chaque ligne dans le catalogue du prestataire ; aucun taux national par défaut ni conversion implicite d'une ligne exonérée en taxable.
2. Préparer les taxes par le résolveur V5 existant, après autorité Auth/D1, opt-in et grant TEST versionnés, configuration US/USD/accrual, source et période courantes, contexte fiscal DB-owner valide et marchand TEST dédié vérifié. Cette préparation réserve et conserve l'observation privée mais ne crée pas de facture ni de journal.
3. Montrer un aperçu public fermé : source et dates, destination choisie, montants avant taxe, taxe et total exacts, lignes et référence de revue opaque. Identifier clairement la nature TEST. Un calcul n'est pas une transaction fiscale ni une preuve de conformité générale.
4. Une confirmation distincte émet la facture par `executeUsFinancialKernelV5`, avec CAS, écriture équilibrée, numéro serveur, snapshots et preuve fiscale privés existants. L'émission doit relire la préparation ; la référence de revue ne remplace aucune autorisation.
5. Conserver l'enveloppe, les choix, la référence de revue et le requestId exacts en cas de résultat inconnu. Paiements, commerce et facturation partagent un seul verrou navigateur. Un reçu historique exact doit rester consultable sans dépendre de la clé marchand ou du catalogue actuels.

Les contrats navigateur restent distincts d'ERP5 et des données privées. Nouveau DTO de préparation : `consumer`, `schemaVersion`, `requestId`, `expectedRevision`, `command` (`issue_invoice`, `estimateId`, `expectedEstimateRevision`, `date`, `accountingDate`, `dueDate`, `periodId`) et `choices` (`classifications` ordonnées avec `lineId`, `taxCode`, `confirmedService: true`, `taxDateInstant`, `addressSource`). Le serveur dérive `pilot-invoice:<requestId>` et `pilot:invoice:<requestId>` ; le navigateur ne fournit ni rôle, total, numéro, policy, compte marchand ou preuve fiscale. L'émission porte `{request, reviewId}` et lie une revue exacte à la préparation stockée.

Le résolveur et le registre d'opérations fiscaux V5 sont réutilisés. Le hash financier historique ne couvre pas les choix fiscaux du navigateur : comparer explicitement ces choix à la préparation stockée, y compris lors d'une reprise terminée, dans chaque lecture du résolveur et après exécution. Aucun registre parallèle ni nouvelle table ne doit être créé. De fines fonctions PostgreSQL du pilote doivent encadrer lecture, preflight, réservation et calcul fiscal avec les versions opt-in/grant déjà utilisées par le livre, sans élargir l'ancien protocole.

## Limites fiscales et admission

La capacité actuelle admet des services taxables à prix hors taxe, quantités entières positives, destination US, USD et accrual. Les biens, exonérations, quantités fractionnaires, taxe inclusive et autres cas restent explicitement refusés jusqu'à leur traitement fiable. Ce périmètre du prestataire n'est pas une règle comptable ou légale applicable à toutes les entreprises américaines.

Le contexte V5 reste provisionné par une autorité administrative distincte : aucun formulaire public ne doit pouvoir fabriquer le nexus, une inscription fiscale, une observation de prestataire ou une autorisation DB-owner. Un contexte absent, périmé ou incohérent bloque l'opération avec un message utile. Aucun secret SaaS CH ne peut devenir une clé marchand. Les recherches juridiques doivent citer les autorités pertinentes et distinguer leurs obligations des choix de Zentra ; aucune prétention US GAAP ou certification.

## Répartition et fichiers prévus

- Contrat et projections publics : nouveaux modules `us-financial-pilot-invoice*` ; réutiliser les primitives de money, dates et validation privée.
- Routes et bindings : trois routes privées de préparation, émission et catalogue sous le consommateur existant ; nouveau serveur et binding, mêmes autorités et flags fermés.
- Persistance : migration additive de wrappers du pilote, générée par la CLI locale ; ne pas réécrire les migrations précédentes. Tests SQL sur la chaîne pilote existante plus cette migration, avec retour arrière par fermeture des flags sans effacement des opérations.
- Navigateur et interface : session partagée, copie FR/DE/IT/EN, dates/fuseau explicites, formulaire et revue intégrés aux devis existants, thèmes et mobile conservés. Aucun changement marketing ou refonte globale.
- Livraison : compte rendu en huit rubriques, empreintes et résultats réels. Une étape non exécutée restera signalée comme telle.

## Vérification prévue

Tester les DTO fermés, getters/prototypes/champs privés, limites, IDs serveur, arrondis exacts, dates et choix liés aux lignes ; préparation sans effet comptable ; émission réelle par le noyau et le PostgreSQL locaux avec journal équilibré ; reprise exacte après réponse perdue et paiement intermédiaire ; refus si choix/revue/source/période changent ; catalogue ou fournisseur indisponible ; retrait de droits/opt-in/grant et isolation des espaces ; priorité des reçus historiques sans dépendance au marchand actuel.

Le test PostgreSQL doit exécuter les migrations versionnées, les nouveaux wrappers, les handlers et une fermeture/réouverture propre. PGlite sérialisé ne prouve pas concurrence multiconnexion, charge, crash ou hébergement. Recette visuelle groupée ordinateur/mobile, quatre langues, deux thèmes, états bloqué/préparation/revue/émis/incertain/refus ; au plus une correction groupée et une confirmation. Puis typecheck, lint ciblé, régression conservant les 175 fichiers précédents, marque et build, sur sources figées.

Aucune modification de production, migration destructive, donnée client, abonnement, distribution native ou déplacement de région n'est autorisée par ce plan. L'ouverture hébergée, les prestataires réels, l'admission native et les validations professionnelles demeurent des étapes de l'objectif complet.
