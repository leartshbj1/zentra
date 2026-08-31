# Sécurité des dépendances JavaScript

Le contrôle reproductible des dépendances de production se lance depuis la racine :

```powershell
pnpm audit:prod
```

Les alertes `GHSA-w3rx-r6r6-pgpr` et `GHSA-5p2g-fcmc-qvqq` sont ignorées par cette commande uniquement après application du patch versionné `patches/image-size@2.0.2.patch`. Au 31 août 2026, le registre ne propose pas la version corrigée 2.0.3 annoncée par les avis. Le patch retire les gestionnaires HEIF, ICNS, JXL et JXL-stream de la table des formats détectables. Elyko n’utilise aucun de ces formats pour les métadonnées du site; PNG, JPEG et SVG restent pris en charge.

Références :

- <https://github.com/advisories/GHSA-w3rx-r6r6-pgpr>
- <https://github.com/advisories/GHSA-5p2g-fcmc-qvqq>
- <https://github.com/github/advisory-database/issues/9028>

À chaque mise à jour de `image-size` ou de `vinext`, supprimer d’abord l’exception et vérifier si une version amont corrigée permet de retirer le patch.
