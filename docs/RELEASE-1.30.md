# Zentra 1.30.0

Cette version simplifie le travail depuis les relevés bancaires et corrige des incohérences entre achats, journal et TVA.

- Banque : rapprochez un débit d’une dépense déjà enregistrée ou créez un achat avec son justificatif PDF, JPG, PNG ou WebP. L’achat, le fichier et son écriture sont enregistrés ensemble. Le projet choisi retrouve également le justificatif.
- Corrections bancaires : retirez une association erronée avec un motif conservé dans l’historique exportable. Cette dissociation conserve le paiement de la dépense. Une nouvelle tentative ne recrée pas un achat ni une ancienne association supprimée.
- Avoirs fournisseurs : les compensations portent une date et leur propre preuve. En mode TVA reçu, les compensations et leurs extournes sont ventilées entre les pièces avec conservation des montants et des périodes précédentes.
- Journal et TVA : une dépense payée ne peut plus être annulée seulement dans le journal. Les anciennes extournes erronées peuvent être rétablies après contrôle de leur chaîne ; le centre TVA indique l’écriture à vérifier lorsqu’un décalage empêche l’export.
- Interface : formulaires adaptés aux petits écrans, historique repliable et paginé, références longues lisibles et erreurs visibles près des actions. Une réponse perdue se reprend sans double écriture ; après un enregistrement confirmé, la reprise recharge les données.
- Mises à jour : la fenêtre de maintenance utilise le comportement commun des dialogues, avec navigation au clavier et protection pendant l’installation.

## Limites conservées

Le rétablissement d’une ancienne extourne et la dissociation d’un relevé n’annulent pas financièrement l’achat. Les remboursements, la remise à payer coordonnée, les paiements ventilés ou en devises, la reprise automatique des soldes lors d’un changement de mode TVA et certains historiques non datés restent à compléter. Les justificatifs HEIC ne sont pas pris en charge dans la nouvelle saisie bancaire.

La distribution Windows/macOS conserve les identifiants de production et la clé de signature des mises à jour. Authenticode Windows et la notarisation Apple restent indisponibles ; macOS demeure proposé en accès anticipé. Les paquets Android et iOS restent des versions de test, sans publication dans les boutiques ni synchronisation des données entre appareils. Les validations détaillées figurent dans [l’audit fonctionnel](AUDIT-APP-2026-09.md).
