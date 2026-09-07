# Audit des fonctions et du design — 7 septembre 2026

## Résultat et périmètre

Audit du code Zentra 1.45.0, base `62f6f3b7c69450bb168450eb8be9790cc1d1279a`, suivi de trois corrections locales. Les 1 575 tests distincts exécutés passent : 742 tests d’interface, 208 tests serveur, 624 tests Rust locaux et le test HTTPS Rust exécuté séparément. Aucun test métier n’a échoué.

Les 16 modules ont été ouverts dans le navigateur de recette aux largeurs 320, 390 et 1 440 pixels. Le second passage sur les modules déjà chargés, à 320 et 1 440 pixels, ne présente pas de chargement persistant ni de débordement global. Le banc de recette fournit des données fictives et simule le pont natif ; les écritures réelles, migrations et restaurations sont contrôlées par les tests Rust, pas par ce navigateur.

Cette recette ne constitue ni une certification comptable ou Swissdec, ni une validation physique d’iOS ou Android. L’application Windows personnelle ouverte pendant l’audit et ses données n’ont pas été modifiées. Les corrections restent dans le code local ; aucun nouveau programme d’installation ni déploiement n’a été distribué pendant cet audit.

## Corrections

- **Aperçu sur petit écran** : à 320 × 568, le pied de page plaçait une explication dans une étroite zone défilante à côté du bouton PDF. Le message et le bouton occupent maintenant chacun la largeur disponible. Après correction, le message tient sur deux lignes sans défilement interne et le bouton d’export reste entier.
- **Réglages TVA** : les trois boutons permettant de retirer un taux étaient constitués d’une icône sans nom accessible ni infobulle. Chaque bouton annonce désormais le taux concerné et son action.
- **Lecture des propositions de paie** : un JSON complet déclenchait une recherche parmi toutes les paires d’accolades imbriquées. Il est maintenant analysé directement une fois ; la récupération des réponses entourées de texte ou en littéraux Python reste disponible. Les 35 tests du parseur, dont la limite de 80 rubriques et les contrôles de provenance, passent. Leur durée locale est passée de 268 ms à 31 ms entre les deux exécutions ciblées ; ce chiffre ne mesure pas l’inférence Qwen ni les performances d’un téléphone.

## Couverture fonctionnelle

| Domaine | Vérification actuelle | Limite de la preuve |
| --- | --- | --- |
| Tableau de bord, navigation et agenda | Ouverture, navigation par recherche, états vides ou renseignés, adaptations aux trois largeurs ; tests de dates et parcours guidé | Pas de mesure de fluidité sur téléphone physique |
| Clients, catalogue et projets | Listes, filtres, formulaires ; création d’un projet fictif avec TXT joint puis facture rattachée automatiquement au client et au projet | Le parcours navigateur utilise le pont simulé |
| Documents et hors ligne | Tests natifs : cache après redémarrage, restauration, envois et suppressions en attente, téléchargements corrompus, séparation des entreprises ; tests serveur de synchronisation | Pas de nouvelle coupure réseau simultanée sur deux installations physiques |
| Devis | Création en quatre étapes, blocage des champs requis, retour entre étapes, notes multilignes, brouillon visible en tête de liste, aperçu mobile et accès au total | Émission financière validée par tests natifs |
| Factures et acomptes | Création depuis le projet ; tests natifs du couple acompte/finale, arrondis, paiements, PDF et sauvegarde, reprise des anciens acomptes | Le scénario complet avec paiement n’a pas été rejoué sur les données de l’utilisateur |
| Commandes, livraisons et stock | Ouverture responsive ; tests du cycle devis → commande → livraison → facture, quantités partielles et absence de double sortie | Parcours natif testé automatiquement |
| Relances, temps et rapports | Ouverture responsive ; tests des scans répétables, dates, pointage, facturation des heures et agrégats monétaires | Aucun e-mail réel envoyé |
| Achats et avoirs | Ouverture responsive ; tests des factures fournisseurs, réceptions, paiements, pièces justificatives, remboursements et annulations | Données de test exclusivement |
| Banque | Import simulé de 33 mouvements : paiement exact et partiel, mouvements incertains à contrôler, recherche sans accents, second import sans doublon ; parseur et rapprochements réels testés en Rust | Aucun relevé bancaire personnel importé |
| TVA et comptabilité | Tests des méthodes de décompte, TVA due et préalable, encaissements partiels, avoirs, changements de méthode, équilibre du journal, clôture et exports | Ne prouve pas l’adéquation des paramètres fiscaux de chaque entreprise |
| Paie et certificat annuel | Navigation des collaborateurs et des 32 fiches de recette ; tests de calcul, arrondis, bases AVS, sauvegarde atomique et certificat sur formulaire officiel avec annexe | Le formulaire annuel du banc navigateur ne simule pas son nouvel appel natif ; l’export officiel est couvert par les tests Rust. L’inférence complète Qwen n’a pas été relancée ici |
| Logos et présentation des documents | Huit PDF produits par le moteur natif, dix pages rendues et inspectées : devis, factures, fiches de salaire et comptes annuels, chacun en Signature et Épurée | Exemples fictifs, pas de document comptabilisé modifié |
| Accès, licences et collaborateurs | Tests serveur et natifs : identité, autorisations, quotas et révocation ; requête HTTPS réelle refusant correctement un faux jeton | Aucune nouvelle transaction Stripe ni création de compte réelle |
| Sauvegardes et mises à jour | Tests natifs des restaurations, intégrité des fichiers, signature et règles de mise à jour ; rubrique accessible dans la navigation | Aucun nouveau cycle installation/mise à jour sur les quatre systèmes |

Les huit catégories de paramètres actuelles incluent une rubrique distincte « Présentation des documents ». Les erreurs `invoke` observées dans les rubriques connectées du banc navigateur correspondent à des appels natifs non simulés. Elles ne sont pas présentées comme des défauts reproduits dans l’application installée ; ces parcours restent des limites de la recette visuelle.

## Documents, calculs et sources suisses

Le devis saisi à l’écran comporte 250,00 CHF nets, 20,25 CHF de TVA et 270,25 CHF TTC. Ses paragraphes sont conservés après retour entre étapes et dans l’aperçu (`white-space: pre-line`). La facture créée dans le dossier du projet comporte 100,00 CHF nets et 108,10 CHF TTC.

Les PDF natifs de démonstration conservent le logo, les couleurs, les totaux et les mentions de brouillon. Le bilan d’exemple présente 178 000 CHF des deux côtés et un résultat de 20 000 CHF repris dans le compte de résultat. Les dix pages ont été inspectées après rendu ; aucun chevauchement de montants ou élément manquant constaté sur ces exemples.

Les taux actuellement publiés par l’AFC sont 8,1 %, 2,6 % et 3,8 %, cohérents avec les choix proposés. Source consultée le 7 septembre 2026 : [taux de TVA suisses](https://www.estv.admin.ch/fr/taux-de-la-tva-suisse). Le formulaire annuel et ses instructions restent disponibles auprès de l’[AFC / CSI](https://www.estv.admin.ch/fr/certificat-de-salaire-et-attestation-de-rentes). Les tests logiciels ne remplacent pas le contrôle de la situation fiscale et des classifications salariales réelles.

## Exécution et preuves

Toutes les traces de cette recette sont dans `.qa/full-audit-20260907/` :

- `server-tests.log` : 208 tests / 30 fichiers.
- `ui-tests-release-candidate.log` : 742 tests / 108 fichiers après les trois corrections.
- `native-tests.log` : 624 tests réussis, un test réseau volontairement ignoré par la suite ordinaire.
- `native-https.log` : ce dernier test réseau exécuté et réussi séparément.
- `pdf-tests.log`, `pdfs/` : génération native des huit PDF et rendus PNG des dix pages.
- `desktop-build-final.log`, `lint.log` : compilation TypeScript/Vite et lint serveur réussis.
- `payroll-timeout-recheck.log`, `payroll-parser-final.log` : vérification isolée du parseur avant/après son optimisation.

Lors d’une exécution simultanée avec le moteur Rust, un test UI a dépassé 5 secondes. Le cas a réussi isolément, puis les 742 tests ont réussi sur une machine moins occupée et à nouveau après l’optimisation. Le délai n’a pas été augmenté pour masquer cet événement.

La construction signale encore les gros modules `WorkspaceApp` (611 ko minifiés) et ExcelJS (930 ko, importé à la demande). Il reste donc une marge d’allègement ; cette recette ne prétend pas démontrer des performances parfaites sur les appareils les moins puissants.

## Vérifications externes restantes

- Installation, caméra, import de documents, coupure/reprise réseau et mise à jour sur un iPhone et un Android physiques.
- Livraison réelle des e-mails d’inscription et de réinitialisation avec le domaine et le service SMTP de production.
- Nouvelle recette de synchronisation réelle entre deux appareils et de l’inférence Qwen sur chacun.
- Publication des corrections locales dans les prochains paquets distribués.
