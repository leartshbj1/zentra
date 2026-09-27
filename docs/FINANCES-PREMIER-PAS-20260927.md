# Comptabilité, banque et relances — premiers pas simplifiés

Correction du point 9 de l’audit du premier client. Ce lot conserve le système visuel de Zentra et les opérations métier. Il est dans les sources, postérieur à l’installateur public 1.90.4 ; aucun nouvel installateur ni changement serveur n’est publié par ce lot.

## Comportement

- Comptabilité sans configuration et sans écriture : une seule étape propose de préparer les comptes. Le parcours existant de vérification et d’activation reste obligatoire. Les conditions commerciales restent accessibles dans un détail secondaire. Les états déjà alimentés restent affichés, même si les liaisons doivent être corrigées.
- Une lecture initiale de comptabilité qui échoue ne doit jamais ressembler à une entreprise vide : le message propose de réessayer. Les montants fictifs et le bouton de première configuration ne sont pas affichés avant la lecture réelle de la configuration.
- Banque sans relevé : prochaine action explicite, avec import toujours accessible avant la configuration comptable. Les recherches, filtres, compteurs et historiques vides disparaissent. Les relevés et mouvements existants restent consultables ; le blocage des rapprochements sans comptes et les contrôles natifs sont conservés.
- Relances : les éléments existants passent avant la configuration. L’absence de modèle actif ne masque plus une relance à traiter. Les résumés sont repliés après la file ; le grand panneau introductif et les explications répétées sont supprimés.
- Une lecture initiale de relances en cours ou en échec n’affiche plus « aucune relance ». La pause, le premier contrôle et une file vide après contrôle possèdent des messages distincts. Un lien ouvre les réglages pour reprendre une préparation en pause.
- Les confirmations d’envoi, les preuves d’action, les soldes revérifiés, les accès en lecture seule et les motifs de clôture restent inchangés. Aucun e-mail ni paiement réel exécuté pendant la recette.

## Validation

- 64 tests existants passent dans cinq fichiers : financeClarity, accountingSetup, bank, remindersUi et reminderBridge.
- `tests/financial-first-steps.mjs` passe 27 contrôles de vues et parcours. WebKit 390 FR clair et DE sombre, Edge 1440 IT clair et EN sombre, WebKit 320 DE sombre avec la vraie préférence de texte à 200 %.
- États vérifiés : configuration, ouverture du guide de relances, accès aux comptes, ouverture de l’import, comptabilité contenant des écritures malgré une configuration incomplète, lecture seule, pause, premier contrôle, file vide, relance sans modèle actif, lecture lente, échec et reprise de lecture.
- Le relevé fictif est choisi et importé via le vrai dialogue frontend, puis ses mouvements s’affichent. La comptabilité non configurée reste signalée et les actions protégées. Les RPC natifs sont simulés : ce test ne valide pas le parseur XML natif ni un encaissement bancaire réel.
- Aucun débordement horizontal ou exception JavaScript détecté dans ces parcours. Détecteur ciblé sans constat, TypeScript et build complet (marque, palette sombre, Vite) réussis. L’avertissement de poids du module Excel reste ouvert.

Deux passages visuels groupés ont conduit à aplatir les panneaux de Relances et à mettre les anciennes relances avant la configuration. Les premiers scripts attendaient à tort des mouvements avant l’import du relevé fictif ; ce scénario de test a été corrigé pour effectuer l’import. La dernière vérification fonctionnelle a réutilisé les captures finales, sans troisième cycle de polissage.

## Preuves et limites

`desktop/.impeccable/review/financial-first-steps/results.json`, 27 captures PNG et `detector.json` ; `outputs/financial-first-steps.log`, `financial-first-steps-unit.log`, `financial-first-steps-build.log`.

Les nouvelles instructions sont traduites en français, allemand, italien et anglais. Cela ne certifie pas la traduction intégrale des outils comptables : des libellés anciens de navigation restent en français sur certaines vues allemandes. À 200 %, les textes longs utilisent plusieurs lignes et la page reste défilable. VoiceOver, appareils physiques, connexion, partage entre appareils et publication native restent des validations distinctes.
