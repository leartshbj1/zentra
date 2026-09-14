# Zentra 1.64.0 — Mobile, apparence et accès d’équipe

Le menu mobile suit le doigt depuis le bord gauche, puis se referme par un geste inverse. Les déplacements verticaux, les champs et les lecteurs de documents ne déclenchent pas ce geste. Les commandes respectent les zones réservées de l’écran. Les devis, factures, PDF et images disposent du zoom à deux doigts et du déplacement dans le document.

Paramètres → Apparence propose Clair, Sombre et Automatique. Le choix est conservé sur l’appareil, appliqué dès le démarrage et transmis aux interfaces natives. Les surfaces sombres sont préparées à la compilation et ajustées par une palette sémantique. Les documents gardent leurs couleurs d’impression. Les options système de réduction des animations et de la transparence sont prises en compte.

Paramètres → Compte et équipe propose le partage des coordonnées, la création d’un lien d’invitation et l’annulation des invitations en attente. Les rôles et places sont contrôlés sur le serveur : Solo 1, Start 3, Pro 10, titulaire compris. Les invitations en attente réservent une place. Le destinataire accepte le lien avec sa propre adresse e-mail. Un nouveau code de connexion ne peut plus être remplacé par une réponse tardive du code précédent.

Au démarrage, Rejoindre une entreprise récupère son identité et son activité via Supabase. Aucun espace existant n’est remplacé. Le partage des fichiers de projets existant est conservé ; cette version ne synchronise pas toutes les entités commerciales ou les écritures comptables. Les invitations sont transmises par lien, sans envoi automatique d’e-mail.

## Contrôles avant compilation

- Construction TypeScript/Vite réussie.
- 25 tests serveur : rôles, sièges, invitations, expiration, révocation, séparation des entreprises et profil filtré.
- 10 tests natifs des comptes, dont création d’un espace vide depuis le profil partagé et refus de remplacer un espace existant.
- Gestes et lecteur sur Chromium/Edge : 320 × 568, 390 × 844 et 844 × 390, avec simulation des zones sûres ; saisie tactile via CDP pour le menu, événements tactiles à deux doigts pour le zoom.
- Mode sombre : choix conservé, retour au clair, changements système, écrans de gestion à 390 et 1440 pixels, documents blancs et règles sombres exclues de l’impression.
- Supabase : table zentra_company_profiles créée avec RLS, accès serveur confirmé, accès anonyme refusé. Clé serveur protégée dans Sites, révision d’environnement 25 à appliquer au déploiement.
- WebKit local sur Windows se ferme avant de créer une page ; le workflow Mac inclut ce contrôle sur macOS avant compilation.

Les artefacts et publications seront consignés après vérification. Les simulations ne remplacent pas un essai sur iPhone physique. La version Mac reste distribuée avec signature ad hoc tant que l’adhésion Apple Developer n’est pas active.

Références : [Apple — Gestures](https://developer.apple.com/design/human-interface-guidelines/gestures), [WebKit — Designing Websites for iPhone X](https://webkit.org/blog/7929/designing-websites-for-iphone-x/).
