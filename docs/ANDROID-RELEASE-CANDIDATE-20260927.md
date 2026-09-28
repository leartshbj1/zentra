# Android — candidat optimisé

Travail du 27 septembre 2026, non publié. La release publique 1.90.6 et son certificat de test restent inchangés.

## Premier paquet rejeté

CircleCI **156**, source `42275745e77d72a963a2f6402a5c3541dc0fb1b9`, a compilé un APK arm64 optimisé de **39 747 291 octets**. Le contrôle a ensuite correctement refusé `libhelvichantier_lib.so` : les segments ELF n’étaient pas compatibles avec les pages mémoire de 16 Ko. Le job s’est terminé en échec le 27 septembre à 21:14:12 UTC. Ce paquet n’est ni signé, ni publié, ni proposé aux clients.

Preuves locales : `outputs/android-release-candidate-20260927/job156/{status.json,build.log,package.txt,alignment.txt}` et APK candidat refusé dans le même dossier. La réussite de `zipalign` vérifie l’archive ; elle ne suffit pas à valider l’alignement interne des bibliothèques natives.

## Correction et garde

Le build Rust applique à la bibliothèque Android les options `max-page-size=16384` et `common-page-size=16384`, dans les deux modes de compilation. Les cibles Windows et Apple ne reçoivent pas ces options. Cette configuration suit la [documentation officielle Android pour le NDK r27](https://developer.android.com/guide/practices/page-sizes#compile-r27).

Le contrôleur examine également la fin des segments RELRO, en complément de chaque segment LOAD, pour éviter de déclarer compatible un binaire qui pourrait échouer au chargement. **Six tests du contrôleur réussissent**, dont le refus d’un RELRO mal aligné, des mauvaises architectures, d’un paquet débogable et d’un manifeste dangereux.

## Compilation corrigée et contrôle indépendant

CircleCI **157**, source `a490d797e2358dc95fc1615e48ea82eb400f86b1`, a réussi le 27 septembre à **21:41:38 UTC / 23 h 41 en Suisse**. L’APK arm64 optimisé pèse **39 747 291 octets**, contre 122 885 130 pour l’APK de test public : environ 68 % de moins. SHA-256 : `aff706d3c1d42c0222cbee2a365e14ba5bfc65c0b685d7a294491df2b760168d`.

Le paquet téléchargé a été contrôlé indépendamment : empreinte conforme au manifeste, intégrité ZIP, architecture arm64, quatre segments LOAD et fin des segments RELRO correctement alignés. Le manifeste indique `ch.zentra.mobile`, version 1.90.6/code 1090006, SDK minimum 24/cible 36, sans `debuggable`, `testOnly` ni sauvegarde Android autorisée. Preuves : `outputs/android-release-candidate-20260927/job157/{status.json,release-candidate-proof.json,local-verification.json,SOURCE.txt,SHA256SUMS.txt,package.txt,alignment.txt}`.

**Candidat non publié.** Au 28 septembre, [la signature locale persistante est vérifiée et le contenu applicatif a démarré/redémarré sur émulateur](ANDROID-SIGNATURE-ET-RECETTE-20260928.md), avec un certificat jetable distinct pour cette recette distante. Aucun appareil physique validé. Il contient la correction PDF mais précède les lots Planning, explication du refus Windows et traductions de l’écran de mise à jour. Son numéro technique 1.90.6 ne permet pas de remplacer la release publique immuable : une future livraison devra avoir une nouvelle version et intégrer les sources finales.

Ces contrôles ne remplacent pas la signature, la continuité de mise à jour avec les installations existantes, le démarrage sur Android ni les tests sur appareil. Aucune clé de production n’est communiquée au job. Aucun paquet non vérifié ne remplace un téléchargement public.
