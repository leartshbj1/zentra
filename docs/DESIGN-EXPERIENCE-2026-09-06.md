# Refonte de l’interface et de l’aperçu des documents

La refonte conserve les verts, fonds clairs et accents ambrés de Zentra. Elle couvre les surfaces communes de l’application Tauri : navigation, en-têtes, tableaux de bord, listes, états, onglets, formulaires et dossiers de facturation. La navigation sur ordinateur utilise un panneau indépendant ; sur mobile, les actions et onglets restent tactiles et les listes sont présentées en cartes.

Les changements de page, dialogues et boutons utilisent des animations courtes, sans bibliothèque supplémentaire. Le réglage système de réduction des animations les désactive. La navigation remet la nouvelle page en haut sans attendre la fin de l’animation.

## Devis et factures

- Bouton Aperçu explicite, disponible aussi sur les brouillons sans les émettre.
- Mode Lecture initial sur téléphone et tablette, avec les lignes détaillées en cartes et leurs libellés.
- Mode Mise en page à largeur de document constante, ajustement automatique à l’écran, zoom manuel et défilement dans l’aperçu.
- Accès aux totaux depuis le montant en haut, export PDF toujours accessible, retour d’erreur et nouvelle tentative d’export.
- Dialogue avec focus contenu, arrière-plan inerte, fermeture par Échap et restitution du focus.
- Suppression des hauteurs fixes qui masquaient la fin des longues factures dans l’aperçu écran, y compris avec QR.
- Le mode Lecture conserve les coordonnées de paiement, la référence et le code QR ; le récépissé détachable figure dans Mise en page. Les mises en page écran ne changent ni les montants, ni les instantanés des documents, ni le moteur natif d’export PDF.
- Le dossier devis–acompte–solde conserve ses fonctions, avec une présentation cohérente des deux factures.

## Vérifications

- Compilation TypeScript et construction de l’interface de production réussies.
- Suite UI existante : 702 tests réussis.
- Parcours exécutés dans le navigateur sur l’interface compilée à 320, 390, 768 et 1440 px : navigation, listes, création de devis, modes d’aperçu, zoom, accès aux totaux, erreur puis réussite de l’export simulé, focus et réduction des animations. Aucun débordement global ni exception de page dans ces parcours.
- Quatre parcours supplémentaires en lecture seule avec une facture synthétique de 24 lignes et QR : contenu non coupé, section de paiement accessible, échelle écran supprimée pour l’impression et export accessible.
- Huit parcours existants devis–acompte–solde réussis, dont les anciens devis avec un seul acompte : deux factures, déduction, dates, émission et dossier projet.
- Captures inspectées pour ordinateur, mobile, lecteur, mise en page, formulaire et paiement. Preuves locales : `.qa/design-experience/report.json`, `.qa/design-experience/edge-report.json`, `.qa/quote-pair/report.json`, `.qa/design-web-build.log`.
- Huit parcours supplémentaires sous WebKit : quatre parcours de navigation/aperçus/formulaires et quatre longues factures avec QR, aux mêmes largeurs. Le test a révélé que le bouton d’aperçu ne recevait pas toujours le focus au clic ; les deux boutons des listes le reçoivent maintenant explicitement avant l’ouverture. Le retour après Échap fonctionne ainsi sous WebKit comme sous Edge. La préparation du guide de démarrage et l’attente des animations du test ont été adaptées aux moteurs. Captures WebKit du tableau de bord, du formulaire 320 px et du QR mobile inspectées ; rapports dans `.qa/design-experience-webkit/`.

Le premier lot 1.36 a été retenu après la découverte du défaut de focus sous WebKit. Son paquet Windows avait passé la signature, le démarrage et le contrôle du canal HTTPS, mais il n’a pas été publié. Les constructions macOS et mobiles ont été annulées. Le lot 1.37 intègre la correction ; ses paquets, signatures, démarrages et migrations ont ensuite été vérifiés avant publication.

Les scénarios navigateur utilisent exclusivement les données et exports simulés de `desktop/tests`. Ils ne prouvent pas un export natif sur chaque appareil. La refonte est publiée dans la version 1.37 sur le canal Windows/macOS et dans les préversions mobiles, avec les limites de distribution précisées dans `RELEASE-1.37.md` : aucune publication App Store/Google Play ni validation sur téléphone physique. Le parcours bancaire et ses justificatifs sont décrits dans `AUDIT-AVOIRS-FOURNISSEURS.md`.
