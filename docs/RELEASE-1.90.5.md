# Zentra 1.90.5

- Des listes plus simples sur mobile pour les clients, projets, devis et factures, avec les actions secondaires dans le menu de chaque élément.
- Un catalogue plus clair en français, allemand, italien et anglais, et des premiers pas guidés en comptabilité, banque et relances.
- La messagerie sortante peut être partagée dans l'entreprise, avec des droits adaptés aux collaborateurs.
- Les sauvegardes vérifient les documents et le logo avant restauration. Une copie incomplète est refusée en conservant les données présentes.
- Windows et Mac recherchent désormais les mises à jour via zentraapp.ch, indépendamment de l'activation du compte.

Source commune : `3dfe7849b1ee6d4c1195f89927c7fc134e1cb72d`.

L'installateur Windows et le paquet Mac ont été démarrés et relancés dans des profils isolés. Sur Windows, le passage de 1.90.4 à 1.90.5 puis la restauration d'une sauvegarde sur un profil neuf ont conservé les 110 tables contrôlées, les trois fichiers et les montants du jeu fictif. Une archive privée d'un document a été refusée sans altérer ces données. Ces essais ne valident pas tous les parcours métier ni les appareils mobiles physiques.

Distribution : Windows sans certificat Authenticode ; Mac universel signé ad hoc, sans notarisation ; IPA iPhone non signé ; APK Android arm64 de test, débogable. Les signatures des paquets de mise à jour Windows et Mac sont vérifiées. Aucun dépôt App Store ou Play Store.

L'incident de quota du service de comptes et la remise en service du traitement automatique lorsque l'application est fermée restent suivis séparément. Cet installateur ne les résout pas. Les anciens canaux Supabase n'ont pas été modifiés : les installations antérieures peuvent nécessiter le téléchargement manuel du nouvel installateur.


## Preuves de livraison du 27 septembre

Publication GitHub à 19 h 32, douze empreintes vérifiées, quatre téléchargements principaux HTTP 200 à 19 h 34. Sites 291 publié à 19 h 39 ; canaux anonymes Windows/Mac/commun contrôlés à 19 h 40. Source du site `ca1ec4c62432ce68b03de99c4b732f9868ded545`.

1 759 tests frontend dans 219 fichiers, 14 contrats de livraison, TypeScript et build réussis avant gel. Apple 146, Windows 147, Android 148 et vérification séparée Windows 149 réussis. Les corrections Automation `43331dab` sont postérieures au gel et ne sont pas contenues dans ces fichiers.

La récupération Windows réelle confirme 110 tables et trois fichiers identiques après installation, restauration sur profil neuf sans source accessible et refus d'une copie incomplète. Les sélecteurs de fichier/dossier n'ont pas été testés ; jeu métier injecté hors ligne, pas de compte/licence client. [État canonique et limites](ETAT-LIVRAISON.md).
