# Zentra 1.51.0 — interface et paie guidée

Version Windows préparée depuis la release 1.50.0, en conservant le schéma natif 59. Les autres travaux métier du dossier principal sont exclus.

- Nouvelle présentation claire de l’application, navigation légère, cartes lisibles et transitions de pages respectant la réduction des animations. Les styles sont limités à l’écran pour préserver les documents imprimés.
- Collaborateur en trois étapes : identité, travail et salaire, récapitulatif. Coordonnées facultatives, import de document et réglages particuliers sont regroupés dans des sections ouvrables. La validation retrouve le champ à corriger, y compris dans une étape masquée. Les retours et erreurs conservent la saisie.
- Fiche de salaire : la seule personne active est présélectionnée avec son salaire récurrent. Les personnes inactives restent disponibles uniquement pour modifier leurs fiches existantes.
- Corrections de paie : un premier point est présenté avec son action directe ; les autres restent accessibles dans une liste ouvrable. Aucun contrôle de cotisation n’est supprimé et aucun montant d’assurance n’est inventé.
- Canal de mise à jour Windows inchangé : `latest-windows.json`, contrôle et badge de disponibilité existants conservés. Le canal `latest.json` de macOS et des anciennes installations reste distinct.

Vérification : création collaborateur sous Edge et WebKit, 320/390/844/1440 pixels, validation, retours, nouvelle tentative après erreur et données transmises. Parcours de pension et préparation de paie contrôlés à 320/390/1440 pixels. Compilation TypeScript. Les essais de navigateur utilisent des données fictives ; ils ne prouvent pas une installation physique native.

La publication et les empreintes des artefacts sont à reporter après leur vérification. Aucun nouveau paquet macOS, iOS ou Android n’est inclus.
