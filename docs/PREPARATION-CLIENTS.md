# Préparation de Zentra pour des clients

Objectif accepté : terminer l'ensemble des priorités, avec preuve du parcours réel. Cette liste suit les travaux ; elle ne constitue pas une autorisation de mise en production sans validation technique.

| Priorité | Condition de livraison | Situation |
| --- | --- | --- |
| Données partagées | Deux installations et deux collaborateurs retrouvent clients, devis, factures, banque, paie et comptabilité. Modifications simultanées et hors ligne conservées ; conflits explicites ; pas de doublon de numérotation ni de journal déséquilibré. | À réaliser. Les fichiers de projet seuls ont un protocole de synchronisation. La liste de routes native qui les bloquait est corrigée dans les sources ; nouveaux installateurs à distribuer. |
| E-mails | Domaine vérifié, SMTP Supabase de production, inscription et réinitialisation reçues par un utilisateur extérieur. | Domaine demandé au titulaire. Intégration Resend préparée précédemment. |
| Abonnements | Vendeur et TVA exacts ; achat, activation, renouvellement, défaut de paiement et résiliation validés ; quotas titulaire compris. | Parcours sandbox existant. Informations légales et TVA demandées avant bascule live. |
| Publication | Sources testées, site déployé, installateurs actuels vérifiés ; installation neuve et mise à jour préservant les données. | Audit local précédent disponible. Nouvelle livraison à préparer après les changements. |
| Reprise après panne | Sauvegarde complète hors appareil, reprise d'un envoi interrompu, restauration sur installation vierge, contrôles d'intégrité et conservation d'une copie de sécurité. | Coffre et récupération web après résiliation publiés (site 69, source 730d8b2). Restauration locale sans réactiver la licence testée. Nouveaux installateurs et essai natif HTTPS à fermer. Une sauvegarde ne remplace pas la synchronisation concurrente. |
| Validation professionnelle | Dossier d'essai fiduciaire avec chiffres attendus ; examen du vendeur, conditions d'abonnement, assistance et validation comptable documentée. | Dossier de cinq pages préparé et vérifié visuellement : TVA/bilan, acomptes/banque, paie/certificat annuel et procès-verbal. Les chiffres sont des attendus indépendants ; l'exécution avec pièces produites par l'application puis la validation professionnelle restent à obtenir. |
| iOS et Android | Comptes de distribution actifs, builds signés acceptés, installation physique, droits fichiers/caméra, sauvegarde, reprise réseau et mise à jour testés. | Comptes et appareils à vérifier. Un IPA non signé n'est pas une publication App Store. |

## Invariants

Informations du vendeur confirmées par le titulaire le 8 septembre 2026 : **Shabija Leart**, **non assujetti à la TVA**, assistance **leartshabija@gmail.com**. Adresse professionnelle et domaine encore attendus. Le statut TVA du vendeur de Zentra est indépendant du paramétrage TVA des entreprises clientes.

- Conserver les calculs en centimes et points de base, les pièces émises immuables et les preuves comptables.
- Ne jamais remplacer une base modifiée par la dernière copie reçue sans fusion validée ou restauration expressément confirmée.
- Réserver les sauvegardes intégrales au titulaire et aux administrateurs : elles contiennent notamment les salaires.
- Exclure des copies les secrets de connexion, les licences et les clés propres à l'installation.
- Un échec réseau ne doit ni effacer la copie locale ni annoncer une sauvegarde terminée.
- Les tests simulés, tests SQLite, contrôles du serveur et essais physiques doivent être distingués.

## Travaux indépendants des réponses attendues

1. Corriger et tester le transport des fichiers de projet.
2. Livrer le coffre de sauvegardes, sa reprise d'envoi et la restauration native ; vérifier une vraie archive multi-fichiers sur une installation isolée.
3. Concevoir puis implémenter la réplication métier avec gestion des conflits et tests de deux bases modifiées hors ligne.
4. Préparer les scénarios de recette fiduciaire, conditions commerciales et procédures d'assistance.
5. Effectuer les validations de release puis publier les artefacts vérifiables.

Les réponses sur le domaine, le vendeur et la TVA permettent de reprendre en parallèle l'e-mail et la commercialisation. Elles ne bloquent pas les étapes ci-dessus.

## Point technique intermédiaire

La suite native complète du schéma 59 passe : 636 tests réussis, aucun échec et un contrôle HTTPS public volontairement ignoré. La suite serveur passe avec 240 tests. La réservation de numéros partagés reste inactive ; voir `SYNCHRONISATION-METIER.md`. Ces résultats ne prouvent ni la réplication métier complète ni une installation physique.
