# Android — candidat optimisé

Travail du 27 septembre 2026, non publié. La release publique 1.90.6 et son certificat de test restent inchangés.

## Premier paquet rejeté

CircleCI **156**, source `42275745e77d72a963a2f6402a5c3541dc0fb1b9`, a compilé un APK arm64 optimisé de **39 747 291 octets**. Le contrôle a ensuite correctement refusé `libhelvichantier_lib.so` : les segments ELF n’étaient pas compatibles avec les pages mémoire de 16 Ko. Le job s’est terminé en échec le 27 septembre à 21:14:12 UTC. Ce paquet n’est ni signé, ni publié, ni proposé aux clients.

Preuves locales : `outputs/android-release-candidate-20260927/job156/{status.json,build.log,package.txt,alignment.txt}` et APK candidat refusé dans le même dossier. La réussite de `zipalign` vérifie l’archive ; elle ne suffit pas à valider l’alignement interne des bibliothèques natives.

## Correction et garde

Le build Rust applique à la bibliothèque Android les options `max-page-size=16384` et `common-page-size=16384`, dans les deux modes de compilation. Les cibles Windows et Apple ne reçoivent pas ces options. Cette configuration suit la [documentation officielle Android pour le NDK r27](https://developer.android.com/guide/practices/page-sizes#compile-r27).

Le contrôleur examine également la fin des segments RELRO, en complément de chaque segment LOAD, pour éviter de déclarer compatible un binaire qui pourrait échouer au chargement. **Six tests du contrôleur réussissent**, dont le refus d’un RELRO mal aligné, des mauvaises architectures, d’un paquet débogable et d’un manifeste dangereux.

La compilation corrigée doit encore fournir un nouveau paquet et sa preuve. Ce contrôle ne remplace pas la signature, la continuité de mise à jour avec les installations existantes, le démarrage sur Android ni les tests sur appareil. Aucune clé de production n’est communiquée au job. Aucun paquet non vérifié ne remplace un téléchargement public.
