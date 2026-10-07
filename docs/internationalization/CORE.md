# Socle partagé CH / US

Le socle de `lib/international` est additif et indépendant des données de production. Il fournit des contrats TypeScript, des validations et des calculs exacts. Il ne modifie aucun montant historique, ne migre aucune entreprise et ne branche pas les écrans ou commandes natives. La présence de ce socle ne rend pas les parcours US déjà opérationnels.

## Contrat d’entreprise, version 1

`types.ts` exporte `CountryCode = CH | US`, `Currency = CHF | USD`, `CompanyLanguage = fr | de | it | en`, `AccountingBasis = cash | accrual`, `CompanyAddress`, `TaxConfiguration`, `CompanyConfiguration`, `CountryConfiguration` et `LegacyCompanyResolution`.

La configuration JSON contient explicitement :

```json
{
  "schemaVersion": 1,
  "organizationId": "org-us-1",
  "country": "US",
  "currency": "USD",
  "language": "fr",
  "timeZone": "America/New_York",
  "address": {
    "country": "US",
    "line1": "18 Main Street",
    "city": "Brooklyn",
    "subdivision": "NY",
    "postalCode": "11201"
  },
  "accountingBasis": "cash",
  "invoiceNumberPrefix": "INV",
  "taxConfiguration": { "status": "unconfigured" }
}
```

`line2` et l’EIN US sont facultatifs. L’EIN, lorsqu’il est présent, utilise la syntaxe `NN-NNNNNNN` ; cette vérification ne confirme ni son attribution ni l’identité fiscale. CH interdit ce champ. Le type de configuration est une union discriminée : CH/CHF/adresse CH, ou US/USD/adresse US.

`country-config.ts` exporte :

- `countryConfiguration(code)` : registre typé et gelé, incluant devise, deux décimales monétaires, locales d’affichage, fuseaux autorisés et subdivisions d’adresse. Aucun taux ou secret fiscal.
- `validateCompanyConfiguration(input: unknown)` : lecture stricte, copie validée et gelée. Aucun défaut implicite de pays, devise, méthode comptable ou statut fiscal.
- `resolveLegacyCompany(organizationId)` : retourne `country: unknown`, `requiresAdministrativeReview: true` et `preserveLegacyBehavior: true`. N’inspecte ni ne réécrit l’adresse ou les anciens réglages pour leur attribuer CH.

Les champs inconnus sont refusés aux trois niveaux : configuration, adresse et configuration fiscale. Les objets doivent être des objets simples avec leurs champs requis propres ; tableaux, prototypes métier et clés symboliques sont refusés. Les chaînes doivent être non vides, sans caractères de contrôle ni espaces en bordure. L’identifiant d’organisation est une référence opaque de 1 à 128 caractères alphanumériques, point, soulignement, deux-points ou tiret, commençant par un caractère alphanumérique. Le préfixe de facture accepte 1 à 32 caractères alphanumériques, soulignement ou tiret, avec début alphanumérique.

Le validateur vérifie une cohérence de contrat. Il ne vérifie pas une appartenance, un rôle, un droit de modification ou un abonnement. Ces contrôles appartiennent au serveur. Le pays/la devise ne doivent pas pouvoir être changés après des opérations par un simple appel à ce validateur.

`taxConfiguration.status` accepte `unconfigured` ou `configured`. Le second reste une déclaration de configuration ; il ne prouve pas une détermination fiscale, un moteur US disponible, un droit d’émettre une facture ou une certification. Les adaptateurs fiscaux doivent vérifier leurs propres preuves au moment de l’opération. Le socle n’accepte ni taux US arbitraire ni clé de service dans cet objet.

## Adresses et localisation

`addresses.ts` exporte `validateAddress(input, expectedCountry)`, `formatAddress(address)` et les listes gelées `countrySubdivisions`. CH utilise les 26 codes cantonaux et un code postal à quatre chiffres sans zéro initial. US utilise les 50 États et DC, avec ZIP à cinq chiffres ou ZIP+4. Les territoires ayant leur propre code pays ne font pas partie de ce profil US initial. Le pays de l’adresse doit correspondre à celui de l’entreprise.

Le formatage conserve littéralement noms, rues et villes. Il change uniquement la structure du bloc d’adresse. Aucune traduction ni géocodage n’est effectué ; ces contrôles syntaxiques ne prouvent pas qu’une adresse reçoit du courrier.

`localization.ts` exporte :

- `localeForCompany(company)` : CH utilise `fr-CH`, `de-CH`, `it-CH` ou `en-CH` selon la langue ; US utilise `en-US`. Une entreprise US peut conserver une langue d’interface française ; la langue ne change pas sa juridiction.
- `formatDateOnly(value, locale)` : date civile `YYYY-MM-DD`, validée par le calendrier, affichée sans déplacement de jour. Le renderer utilise explicitement UTC ; il n’interprète pas cette date comme un rendez-vous dans le fuseau de l’appareil.
- `parseInstant(value)` : validation partagée d'un instant ISO avec secondes et offset explicite ; refuse les dates impossibles et ne dépend pas du fuseau de l'appareil. Les fonctions d'audit et de fiscalité réutilisent ce contrôle.
- `formatTimestamp(value, locale, timeZone)` : instant ISO avec secondes et offset explicite (`Z` ou `±HH:MM`), puis rendu dans le fuseau IANA fourni. Les heures sans offset, dates impossibles, heure 24, secondes intercalaires et fuseaux non autorisés sont refusés.

CH autorise `Europe/Zurich`. Le registre US contient les fuseaux IANA des États pris en charge, y compris Arizona, Alaska, Hawaï et variantes régionales. Il refuse les abréviations ambigües telles que `EST`. Le runtime doit également reconnaître la zone. Les transitions d’heure utilisent sa base IANA ; le socle n’invente pas d’offset fixe. Toute locale d’affichage doit être fournie explicitement.

## Montants exacts

`money.ts` exporte les fonctions suivantes :

| Fonction | Contrat |
| --- | --- |
| `money(currency, minorUnits)` | Montant canonique en cents ; accepte une chaîne entière signée et normalise zéros initiaux et zéro négatif. |
| `decimalToMoney(currency, decimal)` | Lit une chaîne en unités majeures et arrondit à deux décimales. |
| `addMoney(a, b)` | Addition exacte, devise identique obligatoire. |
| `subtractMoney(a, b)` | Soustraction exacte, devise identique obligatoire. |
| `multiplyMoney(value, numerator, denominator)` | Ratio entier exact, puis arrondi au cent ; dénominateur non nul. Les facteurs sont des chaînes entières signées. |
| `compareMoney(a, b)` | Comparaison exacte `-1`, `0` ou `1`, devise identique obligatoire. |
| `formatMoney(value, locale)` | Présentation locale et symbole monétaire sans conversion du montant en nombre flottant. |

`Money` est sérialisable : `{ currency: 'USD', minorUnits: '900719925474099301' }`. Les objets produits sont gelés. BigInt reste interne, sans littéraux BigInt, pour compiler avec la cible ES2017 actuelle. Le runtime doit prendre en charge BigInt et `Intl.NumberFormat.formatToParts` avec BigInt ; le package racine impose déjà Node 22 ou plus récent.

Les calculs ne passent jamais par `Number`, `parseFloat` ou un nombre flottant. Le formatage délègue à Intl le signe, la devise et les groupes du montant entier BigInt, puis injecte la fraction exacte. Ainsi `9007199254740993.01` reste `$9,007,199,254,740,993.01` en `en-US`, au-delà des entiers sûrs JavaScript. Les séparateurs typographiques peuvent varier entre bases ICU.

L’arrondi est **half away from zero** : `1.005` devient 101 cents et `-1.005` devient -101 cents. La multiplication rationnelle suit la même règle, y compris avec facteurs négatifs. Les CHF/USD ne sont jamais additionnés, comparés ni convertis entre eux. Aucun taux de change n’est implicite. Le calcul des taxes, leur composition et leur arrondi réglementaire restent la responsabilité des adaptateurs.

Les entrées acceptent les chiffres ASCII, un signe moins facultatif et, pour les unités majeures, un point décimal suivi d’au moins un chiffre. Elles refusent exposants, signe plus, espaces, séparateurs de milliers, virgules, nombres JavaScript et valeurs infinies. Une chaîne numérique est limitée à 1 000 caractères ; un résultat dépassant cette limite est également refusé. La saisie locale éventuelle doit disposer d’un parseur explicite avant ce contrat canonique.

## Téléphones

`phone.ts` exporte `normalizeContactPhone(value, localDialingCountry)` et `formatContactPhone(canonical, displayCountry)`. Le contexte de numérotation doit être explicitement CH ou US. Les numéros US locaux acceptent dix chiffres NANP et un préfixe national 1 facultatif ; les numéros CH nationaux sont normalisés avec +41. Les valeurs internationales explicites utilisent une validation de syntaxe générale et sont conservées, sans déduire le pays de l'entreprise. Extensions et numéros courts ne sont pas couverts.

Le [NANPA](https://nanpa.com/about) décrit des numéros à dix chiffres NXX-NXX-XXXX ; +1 couvre plusieurs pays et territoires, pas uniquement les États-Unis. Ces fonctions ne prouvent ni l'attribution, ni le pays réel, ni la possibilité de joindre un numéro. `phone.test.ts` couvre 14 cas de syntaxe, formats et refus ; aucun fournisseur téléphonique n'est appelé.

## Vérification ciblée

`lib/international/core.test.ts` couvre les valeurs au-delà de l’entier sûr, arrondis positifs/négatifs, ratios, contre-écritures, refus de mélange, formatage exact, cohérence des profils/adresses, champs inconnus, EIN optionnel, immutabilité, résolution historique sans backfill, dates bissextiles et transitions DST CH/US. Ces tests sont indépendants de Miniflare, d’une base client et des fournisseurs externes.

Commande ciblée : `pnpm exec vitest run --config vitest.config.ts lib/international/core.test.ts`. Vérification de types : `pnpm exec tsc --noEmit --incremental false`. Les résultats sont rapportés séparément après exécution ; ce document ne présente pas une recette native ou de production.
