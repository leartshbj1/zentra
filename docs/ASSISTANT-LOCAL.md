# Assistant local Zentra

Le choix d’installer Qwen apparaît au début de la configuration et dans Paramètres → Assistant local. Le modèle existant Qwen3 0.6B Q4_0 (428 970 080 octets) est partagé avec la lecture des fiches. Le téléchargement est volontaire, vérifié par SHA-256, stocké sur cet appareil et réutilisable sans réseau. Une question ne déclenche pas de nouveau téléchargement si le cache a disparu. Annulation, nouvelle tentative et désinstallation ciblée sont disponibles ; les documents et la base métier ne sont pas supprimés.

Le bouton Assistant reste accessible dans les écrans et l’en-tête des formulaires. Le contexte de paie contient la période, le canton, l’étape, le brut saisi, l’état du calcul et les points bloquants réellement affichés. Les noms, AVS, coordonnées bancaires et dossiers complets ne sont pas collectés par ce contexte. L’utilisateur peut consulter les informations utilisées. Les réponses et questions restent en mémoire, sans historique sur disque ni service d’IA distant.

`assistantGuide.ts` contient les consignes propres à Zentra et les procédures sélectionnées selon la question. Il sépare les instructions du contexte et des questions, borne l’historique et interdit les opérations automatiques. Les raccourcis sont des actions d’interface explicitement programmées, activées uniquement par un clic de l’utilisateur.

## Limite constatée et traitement

Le premier essai réel de Qwen a inventé une date malgré les instructions. Les dates de cotisation, la pension, les assurances, la paie et la comptabilité utilisent donc des réponses rédigées et contrôlées dans le guide de l’application, identifiées « Guide vérifié Zentra ». Les autres réponses du modèle portent l’indication « Réponse de Qwen ». Ce dispositif n’est pas un modèle affiné ni un conseiller fiscal autonome ; aucune certification Swissdec ni exactitude générale du modèle n’est revendiquée. Les éléments financiers restent déterminés par le moteur métier et les documents réels. Le guide inclut des réponses spécifiques au brut/net et reprend le point bloquant du formulaire.

## Vérifications de la livraison

- TypeScript et 25 tests ciblés : contexte borné, consignes séparées, sélection de la LPP/date, refus des dates inventées, annulation, expiration, isolation des anciennes réponses et absence de concurrence avec la lecture des fiches.
- Huit parcours Edge/WebKit à 320×568, 390×844, 844×390 et 1440×900 : installation proposée, assistant, contexte de paie, raccourci LPP, saisie conservée, report du choix et poursuite de l’onboarding.
- Vrai Qwen GGUF, sans réponse simulée, sur Edge : chargement, réponses date/pension, réutilisation après rechargement avec les connexions externes bloquées et extraction de l’identité d’un salarié synthétique.
- Les parcours de mise en page utilisent une simulation du service IA ; les réponses du modèle sont vérifiées séparément. Aucun test sur un iPhone/macOS physique n’est attesté ici.

Références techniques consultées : [Qwen3 0.6B et son modèle de dialogue](https://huggingface.co/Qwen/Qwen3-0.6B), [cache et gestion des modèles Wllama](https://github.ngxson.com/wllama/docs/classes/ModelManager.html). Le téléchargement reste lié à la révision et à l’empreinte présentes dans `payrollAiModel.ts`.
