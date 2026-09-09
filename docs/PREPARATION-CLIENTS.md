# Préparation de Zentra pour des clients

Objectif accepté : terminer l'ensemble des priorités, avec preuve du parcours réel. Cette liste suit les travaux ; elle ne constitue pas une autorisation de mise en production sans validation technique.

| Priorité | Condition de livraison | Situation |
| --- | --- | --- |
| Données partagées | Deux installations et deux collaborateurs retrouvent clients, devis, factures, banque, paie et comptabilité. Modifications simultanées et hors ligne conservées ; conflits explicites ; pas de doublon de numérotation ni de journal déséquilibré. | En cours. Historique initial et envoi reprenable des modifications réalisés en développement. Détection des conflits, contrôle des preuves comptables et des états intermédiaires, positions partagées et empreintes de révision implémentés. Le paquet de réception conserve les données originales et leurs identifiants partagés ; son parcours D1 local vers une copie SQLite native isolée est testé. Restent les validations de commandes et cascades, le commit canonique et son reçu authentifié, la réception par un autre appareil, les fichiers binaires, l’installation récupérable et sa confirmation, la résolution des conflits, l’interface et la recette sur deux appareils. Le schéma natif 61 (format partagé 60) reste non distribué ; la réplication métier complète reste inactive. |
| E-mails | Domaine vérifié, SMTP Supabase de production, inscription et réinitialisation reçues par un utilisateur extérieur. | Domaine demandé au titulaire. Intégration Resend préparée précédemment. |
| Abonnements | Vendeur et TVA exacts ; achat, activation, renouvellement, défaut de paiement et résiliation validés ; quotas titulaire compris. | Parcours sandbox vérifié, bascule live non effectuée. Shabija Leart, non assujetti à la TVA, support leartshabija@gmail.com ; adresse professionnelle encore attendue. |
| Publication | Sources testées, site déployé, installateurs actuels vérifiés ; installation neuve et mise à jour préservant les données. | Version native 1.46.1 publiée ; site public déployé, accès d'historique vérifiés sans authentification (401 et absence de cache). Les preuves de recette identifient chaque version serveur publiée et son commit. Publication initiale, réception et import dans un profil neuf testés localement ; leur recette HTTPS authentifiée reste à faire. Installation neuve et remplacement Windows réussis ; remplacement Mac réussi avec autorisation normale du Trousseau, données et identité conservées. Signatures d'éditeur et notarisation restent à obtenir. Le schéma 61 et son parcours natif de partage ne sont pas distribués. |
| Reprise après panne | Sauvegarde complète hors appareil, reprise d'un envoi interrompu, restauration sur installation vierge, contrôles d'intégrité et conservation d'une copie de sécurité. | Coffre, récupération web après résiliation et installateurs 1.46.1 publiés. Recette native HTTPS réussie : archive de 9,5 Mo, reprise après premier fragment, base et pièces jointes restaurées dans une seconde installation isolée, puis archive et sessions de test nettoyées. Le format 2 en préparation inclut et contrôle les exports historiques ; restauration des vrais XML TVA et ZIP de clôture, réparation d'un export local altéré et retour arrière vérifiés localement. La recette HTTPS du format 2 passe avec 9,5 Mo, reprise du seul fragment manquant et restauration des quatre fichiers dans un second profil isolé. Sa distribution native et l'essai sur un autre appareil physique restent à effectuer. Une sauvegarde ne remplace pas la synchronisation concurrente. |
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

Conservation des fichiers des modifications hors ligne, code natif en préparation : 53 tests de synchronisation réussis, deux essais dédiés explicitement ignorés, 23 tests de justificatifs et trois tests de documents de projet réussis. Clippy passe sans avertissement. Les versions remplacées ou supprimées sont conservées avec leurs preuves et retrouvées après restauration d'une sauvegarde dans un second profil isolé. L'envoi des transactions suivantes et la validation entre appareils restent à réaliser ; cette brique n'est pas encore distribuée.

La source native 1.46.1 (`b83aa865`) passe avec 742 tests d'interface, 647 tests natifs et deux tests ignorés explicitement sur le build Mac ; le contrôle HTTPS de sauvegarde a été exécuté séparément. La suite serveur passe avec 240 tests. L'installateur Windows exact passe en installation neuve et en remplacement de 1.45.0, données et identité conservées. L'APK x86_64 compagnon passe aussi son remplacement exact. Le parcours Mac nécessite l'autorisation du Trousseau et sa recette reste suivie dans `RELEASE-1.46.md`. La réservation de numéros partagés reste inactive ; voir `SYNCHRONISATION-METIER.md`. Ces résultats ne prouvent ni la réplication métier complète ni une installation sur téléphone physique.
