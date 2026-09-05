# Zentra 1.34.0 — publication retenue

**Le lot 1.34.0 n’a pas été publié.** L’audit des APK finaux 33994853696 a retrouvé deux échecs après interruption précoce. Les huit ouvertures des deux scénarios à froid réussissent, mais les deux scénarios interrompus atteignent l’erreur de délai : le moteur répond aux trois lectures de diagnostic, tandis que le signal de disponibilité manque. Les bases sont intègres au schéma 49. Une vérification directe de disponibilité est en cours de correction avant de produire un nouveau lot.

Cette version fiabilise l’ouverture de l’application, notamment sur Android après une installation ou une interruption précoce.

- L’interface attend que le stockage natif et la fenêtre soient prêts avant de charger l’espace de travail.
- Une ouverture restée sans réponse affiche une erreur après 75 secondes avec un bouton « Réessayer », utilisable au clavier et au toucher.
- Les réponses d’une ancienne tentative ne remplacent plus l’état de la nouvelle tentative. Le contrôle partagé du compte peut être relancé après expiration.

La source candidate a réussi 692 tests UI, 535 tests natifs Windows (un ignoré), Clippy et la compilation web. Douze parcours de l’interface de production sur 320, 390 et 1 440 pixels vérifient le délai, la reprise et les réponses tardives. Le binaire natif Windows démarre, se recharge et se rouvre avec une identité DPAPI conservée et une base intègre au schéma 49.

Sur Android, le nouvel APK x86_64 signé réussit seize ouvertures : quatre combinaisons d’installation par défaut ou complète, avec démarrage à froid ou après interruption, puis trois redémarrages par combinaison. Toutes les identités sont conservées et les bases sont intègres au schéma 49. Le contrôle utilise les octets exacts de l’APK, des captures d’accessibilité neuves et les journaux des processus de l’application. Il ne dépend pas d’une inspection CDP pour faire progresser l’ouverture. Les anciens échecs et diagnostics restent documentés dans l’audit ; la cause interne exacte de leur attente n’est pas démontrée.

Ces résultats portent sur le candidat antérieur à la numérotation finale. **Les paquets 1.34.0 ne sont pas encore publiés.** Leur construction, leurs signatures et leur démarrage doivent être contrôlés séparément. Aucun essai sur téléphone physique ni publication dans les stores n’est annoncé. Les préversions mobiles restent des versions de test ; iOS est destiné au simulateur.

Les autres contrôles du lot final réussissent : signature et ouverture/réouverture Windows, base intègre et identité DPAPI conservée ; paquet macOS universel, 536 tests natifs (un ignoré), 692 tests UI, Clippy et initialisation de SQLite ; remplacement Android d’une fixture 1.33 par 1.34 avec conservation du client, du projet, du fichier et de l’identité. L’audit iOS 33994979814 réutilise le ZIP exact : premier lancement, fermeture/réouverture de l’app, puis redémarrage du simulateur avec identité protégée conservée et bases intègres. Les trois captures sont inspectées et montrent l’accueil. Ces réussites n’annulent pas les deux échecs Android finaux.

Preuves candidates : source native `554d8b34fbf49e9320ca42d8192578f90a83f8b3`, conditionnement Android 33993109980, audit des APK exacts 33993306384, `.qa/native-ready/`, `.qa/app-opening/report.json` et `.qa/android-ready-audit-33993306384/report.json`.
