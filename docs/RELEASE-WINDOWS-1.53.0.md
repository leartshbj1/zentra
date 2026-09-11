# Windows 1.53.0 — Reprendre une fiche après correction

## Problème reproduit

Sur la version 1.52.0, après correction du salaire annuel LPP depuis le récapitulatif, le calcul était invalidé et « Enregistrer la fiche » désactivé. Aucun bouton de recalcul n’était visible. La correction exigeait de revenir manuellement à l’étape précédente. Certaines erreurs annuelles étaient orientées à tort vers la pension.

## Comportement

- Après une modification des réglages, le récapitulatif explique ce qui reste à faire. Le bouton principal devient « Recalculer le salaire », puis « Enregistrer la fiche » après contrôle. Le premier clic ne sauvegarde pas automatiquement.
- Les cotisations du profil qui ne sont pas encore dans la fiche peuvent être ajoutées depuis le récapitulatif. Cette action explicite conserve les cotisations et bases manuelles déjà choisies.
- Une base effacée reste inconnue, au lieu de devenir silencieusement zéro.
- Les champs invalides sont nommés, marqués pour les lecteurs d’écran et accessibles directement, même dans une rubrique repliée. Les formulaires de salaire, contrat et cotisation utilisent la même aide.
- La date de choix des petits salaires ouvre « Début d’année », avec le champ et le document à utiliser. La validation annuelle utilise le même parseur que la création du collaborateur.
- Les problèmes connus proposent des guides par étapes et les réglages correspondants. Les pannes temporaires proposent de réessayer, sans conseiller une modification des assurances.

## Vérifications

84 tests unitaires ciblés réussis : orientation, profils, calcul périmé, annualité et contexte assistant. Compilation TypeScript réussie.

Recette `payroll-repair-journey.mjs` : Edge et WebKit, 390 et 1440 px. Base effacée, retour au champ, date annuelle invalide puis correction, recalcul, enregistrement et conservation du salaire, des notes et d’une base manuelle.

Recette `payroll-pension-corrections-journey.mjs` : 320, 390, 1440 px. Salaire annuel, contrat de pension incomplet puis corrigé, deux parts mensuelles, ajout depuis le récapitulatif, correction comptable, recalcul et sauvegarde.

Recette `payroll-guided-journey.mjs` : 320, 390, 768, 1024, 1440 px. Création, références cantonales, résultat tardif rejeté, modification du salaire, retour entre étapes, erreur puis nouvel enregistrement, isolation entre collaborateurs et reprise après indisponibilité des cotisations. Son ancien libellé d’erreur comptable a été actualisé.

L’ancienne recette `payroll-form-journey.mjs`, antérieure au formulaire guidé, s’arrête sur le tutoriel actuel et n’est pas présentée comme réussie. Les trois recettes ci-dessus couvrent le parcours de paie livré. Report dans le dossier principal effectué par patch ciblé ; TypeScript, 86 tests et la recette de correction Edge/WebKit y réussissent aussi.

Ces recettes utilisent des données synthétiques. Elles ne constituent pas une certification de paie, une preuve d’installation native ou une mise à niveau réelle d’un profil client. Aucun changement des taux, règles cantonales ou écritures du moteur natif dans cette version.

## Références de l’aide

Consultées le 11 septembre 2026 : [mémento AVS, petits salaires](https://www.ahv-iv.ch/p/2.04.f), [OFAS, financement de la prévoyance professionnelle](https://www.bsv.admin.ch/fr/financement-de-la-prevoyance-professionnelle). Les primes restent celles des contrats ; le choix annuel et ses justificatifs ne sont jamais inventés.

## Publication

Publié le 11 septembre 2026, source compilée `a29b39f50990ec3c3cef7ca4d8f3b272ce8e1fa2`.

- Installateur `Zentra_1.53.0_x64-setup.exe` : 22 719 743 octets.
- SHA-256 : `3BD035F7E0300BC72B40B10BE75FB8AB72F19A8FC99D79F7B44A3A8F5D1CA14B`.
- Exécutable embarqué : `0086C21763F8CF43842087039C168204CBA9ACDBF30077BA3CB8E4F0A23D0084`.
- Signature directe Tauri/Ed25519 vérifiée sur le fichier téléchargé depuis Supabase avec la clé de confiance existante. Empreinte identique sur GitHub.
- Canal `latest-windows.json` vérifié publiquement en 1.53.0 ; signature identique au fichier public. Précédent canal conservé sous `latest-windows-before-1.53.json` et comparé au fichier d’origine. `latest.json` partagé inchangé.
- [GitHub v1.53.0](https://github.com/leartshbj1/zentra/releases/tag/v1.53.0), accès anticipé publié avec l’installateur, sa signature et son SHA-256.
- [Site Zentra](https://elyko.alb-leart1.chatgpt.site), version 119, source `1014d3a174f1d66c2a2d5dee96ce57b9eb0cc676`, déploiement `appgdep_6aa3f1f7bb788191a353fcff783a8ba3` réussi.

Authenticode indisponible ; installation neuve et mise à niveau d’un profil réel non attestées. Schéma SQLite de livraison conservé à 59. Pas de publication macOS/iOS dans cette livraison Windows.
