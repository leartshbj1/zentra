# Zentra 1.38 — avoirs clients et continuité bancaire

Version en préparation. La version publique reste 1.37.0 tant que les paquets et leurs mises à jour ne sont pas vérifiés et publiés.

Cette version ajoute les règlements datés des avoirs clients : imputation sur une facture, remboursement, correction motivée, solde disponible et justificatifs classés dans le projet. Les écritures et la TVA sont contrôlées avec les événements d’origine. La reprise des avoirs historiques compatibles conserve leurs pièces et demande leurs dates réelles ; les historiques nécessitant un rapprochement spécialisé restent explicitement bloqués.

Banque permet de relier un débit camt.053 à un remboursement client existant ou d’enregistrer un remboursement réel depuis son avoir, avec un justificatif facultatif. La dissociation conserve le règlement et son historique. Une réponse interrompue peut être vérifiée après fermeture de l’application avec la même demande et le même fichier. Aucun ordre de virement n’est envoyé.

La présentation conserve les verts et les accents ambrés. Les raccourcis d’activité, les transitions, la navigation des aperçus, les sections des documents et les formulaires mobiles ont été améliorés. Les boutons bancaires ne demandent plus les comptes de paie d’un module inactif et n’affichent plus une confirmation fournisseur impossible sans candidat.

Le schéma local passe de 52 à 57 par migrations additives. Les nouveaux registres et justificatifs sont conservés dans les sauvegardes et les exports ; les preuves des exercices clôturés restent figées. La mise à jour ne synchronise pas les données entre appareils.

## Vérification avant publication

- Source fonctionnelle : 726 tests UI réussis ; 606 tests natifs réussis et un contrôle HTTPS déjà ignoré dans la suite générale ; 10 scénarios bancaires ciblés réussis après ajout du dernier contrôle de clôture. Clippy toutes cibles et construction TypeScript/Vite réussis.
- Parcours Edge et WebKit avec données de test à 320, 390 et 1440 px : justificatif facultatif, reprise après rechargement, rapprochement, dissociation, lecture seule et stockage indisponible. Les aperçus de documents disposent également de parcours dédiés, décrits dans `DESIGN-EXPERIENCE-2026-09-06.md`.
- À établir pour ce lot : installateurs exacts Windows/macOS, signatures de mise à jour, démarrages et migration d’un profil 1.37, archives mobiles et continuité des identités, contrôle des fichiers distribués et du canal public.

Android demeure une préversion APK et iOS une archive pour simulateur. Une compilation mobile ne constitue ni une publication App Store/Google Play ni une recette sur téléphone physique. Les signatures du canal de mise à jour sont distinctes d’Authenticode et de la notarisation Apple.
