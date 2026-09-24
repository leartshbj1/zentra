# Accueil Automation et finition de l’application — 25 septembre 2026

La séquence d’ouverture Zentra approuvée est réutilisée lorsque l’accès Automation de l’entreprise choisie est confirmé. Les écrans de travail reçoivent des ajustements communs de navigation, de champs, d’actions et de lecture, dans le même univers sobre. La compilation et les contrôles automatisés ont réussi ; la relecture visuelle indépendante conclut **ship** pour le changement frontend examiné.

## Accueil après confirmation de l’accès

L’accueil reprend les filaments lumineux et les particules qui rejoignent le vrai wordmark Zentra. La signature est « Place à ce qui compte. », suivie du titre Automation. La séquence commune dure 7,8 secondes, avec passage immédiat à la composition finale et fermeture possible. Elle s’arrête au repos et se suspend lorsque le document est caché. La préférence de réduction du mouvement affiche directement l’état final.

L’apparition automatique exige un état d’entreprise `ready`, une réponse correspondant à l’entreprise actuellement choisie et un accès `active`. Elle attend un moment calme sur Tableau de bord ou Automation : aucun autre dialogue, aucune région occupée, aucun champ en cours de saisie et un document visible. Une perte d’accès masque l’accueil ; changer d’entreprise remonte le composant avec la nouvelle identité.

La présentation automatique est mémorisée une fois par entreprise dans le stockage local de l’application sur l’appareil. La clé est `zentra.automation.welcome.v1:<identifiant encodé>`. Finir, passer, démarrer ou fermer mémorise la présentation ; la fermeture garde aussi une trace en mémoire si le stockage est inaccessible. Un autre appareil ou un stockage effacé peut présenter l’accueil à nouveau. Le bouton « Revoir l’introduction » des Réglages Automation permet une relecture volontaire, toujours soumise à un accès confirmé et à l’absence d’interruption en cours.

Un administrateur disposant de l’écriture voit « Configurer Automation » lorsque consentement, activation des réglages ou fonctions choisies restent incomplets. Ce bouton ferme l’accueil puis ouvre les réglages existants. Dans les autres cas, « Découvrir Automation » ouvre l’activité complète. Le consentement, les permissions, l’achat et la configuration ne sont jamais accordés ou modifiés par cet accueil. Le seul état écrit est une préférence locale de présentation.

## Continuité des menus et écrans

La couche partagée affine les surfaces existantes ; elle ne remplace pas individuellement les parcours métier :

- Fond clair légèrement allégé, rail distinct et niveaux sombres plus profonds ; feuilles opaques conservées.
- Sélection des menus et rubriques de Réglages sur un vert doux, texte encre et icône verte ; le primaire garde sa couleur d’action.
- Angles de contrôles à 11px, barre supérieure à 64px minimum, boutons et segments avec retour de couleur en 160ms ; pression légère en 120ms, désactivée avec mouvement réduit.
- Arrivée de destination unique en 220ms, sur 4px avec opacité de .72 à 1. L’ancienne animation CSS concurrente et l’animation de titre ont été retirées.
- Champs avec padding commun de 12px 14px et bordure d’accent au focus, y compris face aux sélecteurs sombres hérités. Téléphone : texte de saisie à 16px et hauteur minimale de 48px.
- Interrupteurs Automation cohérents dans le hub et les Réglages généraux : même piste de 42×26px, pouce de 20px, état actif vert et focus visible ; valeurs, désactivation et permissions conservées.
- Actions d’en-tête réorganisables, cellules plus lisibles, états vides aérés et rubriques de Réglages tactiles de 72px minimum. Le briefing Automation de l’accueil repose sur papier.

Les destinations, données, permissions, formulaires et règles métier sont conservés. Le journal complet demeure l’entrée par défaut d’Automation. La séquence de marque ne se rejoue pas à chaque changement de menu.

## Accessibilité, identité et périmètre

Les contrôles de l’accueil gardent un focus visible et les mécanismes du dialogue existant. La fermeture mesure au moins 44px, les commandes secondaires 48px et l’action principale 56px. Les compositions téléphone et paysage court adaptent leurs positions ; les variables natives de zones sûres restent prioritaires. Les libellés sont disponibles en français, allemand, italien et anglais.

Le logo provient de l’asset existant [zentra-wordmark.png](../desktop/src/assets/zentra-wordmark.png), utilisé par BrandWordmark et par les cibles du canvas. Le mouvement est écrit dans le code. Aucun nouvel asset de marque, média externe, son ou paquet d’animation n’est ajouté. Le fond vert profond, les lumières et les boutons en pilule constituent l’exception finie déjà approuvée pour l’ouverture ; ils ne deviennent pas le style général des écrans de travail.

Sources principales : [OnboardingIntro.tsx](../desktop/src/OnboardingIntro.tsx), [AutomationWelcomeDialog.tsx](../desktop/src/AutomationWelcomeDialog.tsx), [automationWelcomeState.ts](../desktop/src/automationWelcomeState.ts), [AutomationSettings.tsx](../desktop/src/AutomationSettings.tsx), [automation-welcome.css](../desktop/src/automation-welcome.css), [workspace-atelier.css](../desktop/src/workspace-atelier.css), [automation-design.css](../desktop/src/automation-design.css), [useScreenArrival.ts](../desktop/src/useScreenArrival.ts) et [translationsAutomation.ts](../desktop/src/translationsAutomation.ts). WorkspaceApp monte l’accueil par entreprise. Le générateur de palette sombre exclut ses couleurs locales comme celles de l’ouverture existante.

Le système commun est consigné dans [DESIGN.md](../desktop/DESIGN.md) et son [sidecar](../desktop/.impeccable/design.json). Le [contrat d’arrivée Automation](../desktop/.impeccable/surfaces/automation-arrival.md) porte les conditions et la composition propres à cette surface. Les anciens contrats de surface et le rapport d’onboarding restent inchangés.

## État des vérifications

Les [résultats Edge](../desktop/.qa/automation-arrival/welcome-edge.json) et [WebKit](../desktop/.qa/automation-arrival/welcome-webkit.json) sont disponibles pour la séquence, le passage, la relecture, la mémorisation et l’accès aux commandes à 1440×900, 390×844, 320×568 et 844×390. Ils couvrent aussi l’accès devenu actif, le report pendant un dialogue, la révocation, l’isolation par entreprise, le mouvement réduit et les quatre langues avec consentement inchangé. Ces parcours utilisent les vrais composants React avec des données fictives et des commandes simulées.

La compilation finale `pnpm build:web` a réussi pour TypeScript et Vite. Les avertissements existants de modules de plus de 500KB subsistent. Les 33 tests unitaires ciblés ont été relancés avec succès.

Les rapports des écrans [Edge](../desktop/.qa/automation-arrival/screens-edge/report.json) et [WebKit](../desktop/.qa/automation-arrival/screens-webkit/report.json) totalisent 224 visites de navigation/rendu : six configurations de 32 états pour Edge et une de 32 états pour WebKit. Aucun événement d’erreur JavaScript de page ni débordement horizontal du document n’y est signalé. Les captures finales attendent le chargement des écrans ; le jeu fictif inclut la lecture du grand livre. La préparation fournisseur est volontairement désactivée dans ce jeu visuel pour éviter une écriture comptable. Ces visites ne certifient pas tous les traitements métier.

Le [rapport de mouvement de l’ouverture initiale](../desktop/.qa/onboarding-arrival/motion-results.json) passe également. La saisie sombre à 16px, sa bordure d’accent au focus et le retour au fond clair `rgb(246, 247, 248)` ont été vérifiés. Les [captures finales](../desktop/.impeccable/review/automation-activation) sont préparées pour la relecture indépendante.

La [relecture visuelle indépendante](../desktop/.impeccable/review/automation-activation/review.md) conclut **ship**, sans nouveau défaut matériel identifié ni correction de code demandée. Son rapport contient les cinq sections du contrat de finition : persistence, fidelity, ceiling, material_fixes et keep. Le reviewer a examiné sept planches contact, dix captures d’accueil individuellement et seize captures d’écrans de travail en pleine résolution ; trois captures de l’introduction approuvée ont servi de référence.

Les 224 visites ont été examinées sur les planches, pas toutes individuellement en pleine résolution. Les captures de fenêtre ne valident pas chaque zone défilée. Le reviewer n’a pas relancé la compilation, les 33 tests ou les contrôles de focus : il a examiné les preuves fournies. Des textes métier français encore présents dans les autres langues, des identifiants de liaison comptable et la coupure d’« Einstellungen » à 320px sont hérités. Le verdict ne constitue donc pas une validation exhaustive de l’accessibilité, des traductions ou de tous les traitements métier. Les nouveaux textes d’accueil sont présents dans les quatre langues.

Aucune installation native, publication web, mise à jour distribuée ou livraison dans les stores n’est attestée pour ce changement par ce relevé. Les résultats navigateur ne valident ni une installation Windows/macOS/iOS/Android, ni les performances d’un téléphone réel.
