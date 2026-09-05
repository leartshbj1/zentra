# Zentra 1.35 — dossiers acompte et solde

Publication en préparation. La version publique reste 1.33.0 ; le lot 1.34 a été retenu après deux blocages Android au contrôle final.

La conversion d’un devis accepté avec acompte crée maintenant deux factures brouillons dans une seule transaction : l’acompte et le solde. Le solde reprend les lignes exactes du devis et déduit les lignes exactes de l’acompte, avec leurs arrondis de TVA. Les deux factures restent accessibles depuis un dossier commun dans Devis, Factures et le projet. Les anciens acomptes isolés disposent d’une action explicite pour créer le solde ; la migration ne crée aucune facture spontanément.

Chaque facture reçoit son propre numéro et sa propre référence bancaire lors de l’émission. Le solde exige l’émission préalable de l’acompte et cite son numéro dans son PDF. La déduction ne crée aucun paiement fictif. Les dates et notes restent modifiables sur les brouillons, tandis que leurs montants et liens sont protégés. La correction automatique isolée d’une facture liée est bloquée ; une réduction peut être documentée par un avoir manuel sur le solde, dans la limite de celui-ci.

Un acompte à 100 % conserve une facture finale à zéro, sans QR de paiement ni écriture comptable ; ce document n’est pas signalé comme une source comptable manquante. La ventilation de TVA sur encaissements tient compte des lignes positives et des déductions lors des paiements partiels. La base passe au schéma 50 et la sauvegarde/les exports conservent les liens du dossier.

La correction du signal de démarrage natif perdu est également incluse : une sonde de disponibilité en lecture seule peut confirmer le démarrage si l’événement natif manque. La publication dépend encore des contrôles des nouveaux exécutables, notamment de l’audit Android après interruption.

## Vérification

- Parcours de conversion et reprise d’un ancien acompte sur 320, 390, 768 et 1440 pixels ; ouverture des deux factures, dates, émission de l’acompte, montants et absence de débordement.
- Tests natifs : deux taux de TVA et prestations exonérées, arrondis de 0,01 à 100 %, décompte convenu/reçu, paiements partiels, PDF, journal et restauration de sauvegarde.
- PDF natifs relus visuellement : acompte sur une page, solde sur deux pages avec la déduction et la référence de l’acompte.
- Suite locale complète : 538 tests natifs réussis, 1 ignoré ; 696 tests d’interface réussis. Clippy avec avertissements interdits et compilation web réussis. Les huit parcours vérifient aussi l’accès depuis le projet et les boutons tactiles.
- Contrôles des nouveaux paquets : résultats à consigner après leur achèvement.
