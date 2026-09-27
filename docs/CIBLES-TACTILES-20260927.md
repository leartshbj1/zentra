# Commandes tactiles — correction du 27 septembre

L’audit mesurait 20 px de largeur pour l’aide, 26 px pour « Tout » d’Automation et 38 px pour certains boutons à icône. Les commandes visées utilisent maintenant au moins 44 × 44 px dans les dispositions inférieures à 861 px. Le dessin reste discret ; l’aide est placée à hauteur du titre, sans recouvrir la création d’une facture. La disposition de bureau reste inchangée.

Le parcours `desktop/tests/mobile-touch-targets.mjs` teste de vrais clics tactiles simulés à trois pixels du bord gauche du contrôle. Il ouvre et ferme le menu, ouvre l’aide puis la ferme au clavier une fois le focus établi, change la période de l’agenda, sélectionne un autre filtre du journal puis revient à Tout. L’aide ne doit pas intersecter le bouton Nouvelle facture.

Douze captures contrôlées en deux passages : WebKit 320px allemand clair, WebKit 390px français sombre, Edge 768px italien clair et Edge 1440px anglais sombre, sur Factures, Agenda et Automation. Les trois configurations mobiles mesurent toutes 44 × 44 px (aide 44 × 46 px). Aucun débordement horizontal ou erreur JavaScript dans ces parcours. Détecteur ciblé sans constat ; TypeScript, contrôle des ressources de marque et build web réussis. L’avertissement du module Excel volumineux reste présent.

Preuves locales : `desktop/.impeccable/review/touch-targets/`, `outputs/mobile-touch-targets.log`, `outputs/touch-targets-web-build.log`. Les premiers essais du script ont été corrigés pour utiliser la destination d’agenda réelle et attendre le transfert de focus avant Escape ; ils ne sont pas comptés comme réussis.

Ce correctif est dans les sources, postérieur à l’installateur 1.90.4. Il ne certifie ni toutes les cibles de l’application, ni VoiceOver, ni un appareil physique.
