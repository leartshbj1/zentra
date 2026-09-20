# Zentra 1.74.0 — Un espace Automation intégré

## Fonctionnement

Le menu et la recherche de navigation présentent Zentra Automation dès que l’accès de l’entreprise est reconnu, même si ses suggestions restent à configurer. L’espace réunit **Vue d’ensemble**, **Outils** et **Réglages**. Le tableau de bord et les outils contextuels permettent d’y revenir directement.

Les réglages conseillés préparent un brouillon avec les fonctions disponibles, le mode suggestion et des seuils de 75 % / 95 %. Ils ne donnent pas l’accord d’analyse à la place du responsable et n’enregistrent rien avant sa validation. Le titulaire et les administrateurs configurent l’entreprise ; les collaborateurs conservent les droits de leur rôle.

Les outils ouvrent les vrais écrans et formulaires de gestion. Une suggestion confirmée ne constitue pas un paiement ou une écriture automatique. Un guide propre à Automation explique ces limites et le parcours.

L’accès se rafraîchit en arrière-plan toutes les 15 secondes et au retour au premier plan. Une panne ne fait pas disparaître un menu déjà reconnu, mais retire l’état utilisable pour les actions. Aucun état n’est réutilisé entre entreprises. Les mises à jour reçues pendant une requête sont rejouées après celle-ci. Un changement distant de consentement n’est plus confondu avec une saisie locale.

## Validation de l’interface

- 1 575 tests réussis dans 190 fichiers, dont activation, révocation, changement d’entreprise, réponses tardives, indisponibilité, reprise et droits des rôles.
- Construction TypeScript et Vite réussie ; avertissements de taille de blocs préexistants.
- 72 vérifications des trois rubriques : 320, 390 et 1 280 px, français / allemand / italien / anglais, clair / sombre. Aucun débordement horizontal détecté.
- Parcours sur données fictives dans le vrai composant WorkspaceApp : menu mobile, configuration conseillée, accord explicite, enregistrement, analyse puis ouverture du formulaire de devis.
- Collaborateur en lecture seule et retour automatique après indisponibilité vérifiés dans le navigateur.

## Distribution

Les preuves de compilation native et de publication seront consignées après la vérification des paquets. Les contrôles d’interface ci-dessus ne constituent pas une installation réussie sur un appareil physique. La mise à jour du site seule n’ajoute pas ces écrans à une ancienne version de l’application.
