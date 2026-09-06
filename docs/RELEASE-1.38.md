# Zentra 1.38 — avoirs clients et continuité bancaire

Version en préparation. La version publique reste 1.37.0 tant que les paquets et leurs mises à jour ne sont pas vérifiés et publiés.

Cette version ajoute les règlements datés des avoirs clients : imputation sur une facture, remboursement, correction motivée, solde disponible et justificatifs classés dans le projet. Les écritures et la TVA sont contrôlées avec les événements d’origine. La reprise des avoirs historiques compatibles conserve leurs pièces et demande leurs dates réelles ; les historiques nécessitant un rapprochement spécialisé restent explicitement bloqués.

Banque permet de relier un débit camt.053 à un remboursement client existant ou d’enregistrer un remboursement réel depuis son avoir, avec un justificatif facultatif. La dissociation conserve le règlement et son historique. Une réponse interrompue peut être vérifiée après fermeture de l’application avec la même demande et le même fichier. Aucun ordre de virement n’est envoyé.

La présentation conserve les verts et les accents ambrés. Les raccourcis d’activité, les transitions, la navigation des aperçus, les sections des documents et les formulaires mobiles ont été améliorés. Les boutons bancaires ne demandent plus les comptes de paie d’un module inactif et n’affichent plus une confirmation fournisseur impossible sans candidat.

Le schéma local passe de 52 à 57 par migrations additives. Les nouveaux registres et justificatifs sont conservés dans les sauvegardes et les exports ; les preuves des exercices clôturés restent figées. La mise à jour ne synchronise pas les données entre appareils.

## Vérification avant publication

- Source fonctionnelle : 726 tests UI réussis ; 606 tests natifs réussis et un contrôle HTTPS déjà ignoré dans la suite générale ; 10 scénarios bancaires ciblés réussis après ajout du dernier contrôle de clôture. Clippy toutes cibles et construction TypeScript/Vite réussis.
- Parcours Edge et WebKit avec données de test à 320, 390 et 1440 px : justificatif facultatif, reprise après rechargement, rapprochement, dissociation, lecture seule et stockage indisponible. Les aperçus de documents disposent également de parcours dédiés, décrits dans `DESIGN-EXPERIENCE-2026-09-06.md`.
- Windows : installateur exact et signature Tauri vérifiés. Le binaire empaqueté démarre, se recharge et se rouvre sur un profil isolé ; la migration 1.37 → 1.38 conserve le client, le projet, son PDF et l'identité d'installation. Le remplacement complet par l'installateur NSIS n'est pas revendiqué.
- Android : l'APK ARM64 conserve le certificat persistant. Le compagnon x86_64 exact réussit seize contrôles de démarrage et deux migrations 1.37 → 1.38 sur émulateur, avec identité, projet et fichier conservés. Une première comparaison de fichier avait échoué ; la cause n'a pas été établie. Les deux essais renforcés suivants contrôlent les octets et l'empreinte calculée sur l'émulateur à chacune des quatre étapes, sans changement des APK et sans nouvelle signature de l'ancien paquet.
- iOS : archive ARM64 pour simulateur contrôlée ; démarrage à froid, relance de l'application et redémarrage du simulateur réussis, avec identité inchangée, base intègre et captures d'écran examinées.
- Source des paquets : `2c18257cf3a167fe6e27111bd04313b60c3398c0`. Les diagnostics Android supplémentaires utilisent `e73aa41a0b1cbac628a852eb4ce295e0f4268978` ; seules les instructions de test et leur script diffèrent, le code distribué reste identique.
- macOS : 726 tests UI et 608 tests natifs réussis (un ignoré), Clippy réussi. Le paquet universel Intel/Apple Silicon et son démarrage natif avec une base intègre au schéma 57 sont vérifiés ; aucune recette interactive complète sur Mac n'est revendiquée.
- À établir : publication et contrôle des fichiers distribués, du canal de mise à jour et de la page de téléchargement.

Android demeure une préversion APK et iOS une archive pour simulateur. Une compilation mobile ne constitue ni une publication App Store/Google Play ni une recette sur téléphone physique. Les signatures du canal de mise à jour sont distinctes d’Authenticode et de la notarisation Apple.
