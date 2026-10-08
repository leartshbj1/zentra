# US Support → Automation → facture fournisseur — recherche primaire

Recherche effectuée le **8 octobre 2026**. Sources publiques consultées à cette date ; leurs contenus et les limites du fournisseur peuvent évoluer. Référence du checkout au relevé : `1e100d26f17594c5bfa62d24c151b60372856d38`.

Périmètre : documentation primaire TypeSafe, IRS, FTC, CPPA et PFPDT ; lecture ciblée du code existant. Aucun appel d'inférence, accès à une clé, création de compte, engagement commercial, transfert de document client, modification métier, migration ou déploiement. Ce document est une base d'architecture et ne constitue ni un avis juridique/comptable ni une certification.

## 1. Conclusion pour le prochain flux

La verticale réalisable est : **réception autorisée → détection → sélection de faits présents dans le document → proposition US persistante → revue humaine → commande ERP fournisseur existante**. La proposition et sa confiance ne sont jamais une autorisation financière. Le premier lot devrait préparer les factures, sans effectuer de paiement, envoyer d'e-mail, déterminer un impôt ni modifier une écriture validée.

Ne pas brancher directement le parseur suisse sur l'ERP US : il contient des conventions de dates JJ/MM et de TVA. Réutiliser les ports d'analyse, de consentement et de transport ; créer une adaptation US explicite des faits et de leur revue. Le journal US partagé demeure la seule autorité financière.

## 2. Capacités TypeSafe effectivement documentées

### Décisions typées, pas rédaction libre

Jev évalue un état à l'aide de trois primitives : choix parmi des options, score sur une grille, et probabilité oui/non. Le fournisseur le distingue d'un modèle de génération de texte. C'est adapté à une catégorie de message, une identité candidate ou une sélection de champ ; cela ne fournit pas une réponse rédactionnelle libre. [Introduction TypeSafe](https://docs.typesafe.ai/introduction).

L'API documente `POST /v1/systemone`, un état textuel/structuré et des questions typées. Un choix accepte au maximum 255 options. Les erreurs de débit/surcharge sont `429` et `529`, avec reprise temporisée ; cette reprise d'analyse ne doit pas rejouer un effet ERP. [Référence HTTP](https://docs.typesafe.ai/api).

La page modèles affiche `jev-1.13.0`, une entrée **texte uniquement**, 64k tokens par requête et 32k pour l'état plus la question la plus longue. Images, audio, vidéo et fichiers binaires doivent être préparés ailleurs. Les limites de débit sont indiquées comme variables ; elles ne constituent pas une capacité Zentra mesurée. Épingler la version évaluée et enregistrer la version retournée. [Modèles](https://docs.typesafe.ai/models).

### Extraction de facture : candidats puis sélection

Le cookbook officiel fournit un exemple de total de facture en USD : le code trouve les valeurs candidates, Jev choisit celle correspondant au champ, puis le code copie et normalise la valeur originale. Une option d'absence évite de forcer une réponse. Le mécanisme n'invente pas une chaîne qui ne figurait pas parmi les candidats ; il peut toutefois choisir le mauvais candidat ou échouer si le bon n'a pas été trouvé. Les noms demandent un registre ou un autre mécanisme de découverte. [Extraction de valeurs préanalysées](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook).

Cette recette n'est pas un service universel d'OCR ni une promesse de lecture parfaite de toutes les factures. Le code de l'exemple utilise une ancienne version de modèle ; reprendre le principe, puis évaluer la version épinglée actuelle, plutôt que recopier ses versions ou ses parseurs monétaires sans examen.

Pour les dates, une recette distincte sélectionne les composantes et confie leur assemblage au code. Les choix manquants ou peu sûrs passent en revue. Ses conventions relatives sont celles de l'exemple, pas une interprétation obligatoire de « next Thursday ». [Extraction de dates](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook).

Le fournisseur signale, dans une page revue le 2 octobre 2026, des limites sur les nombres, les comparaisons de dates, les contextes inutiles et les contenus adversariaux. Calculs exacts, échéances, conversions et validation du calendrier doivent rester déterministes. Une instruction précisant que le document est non fiable ne constitue pas une protection suffisante à elle seule. [Limites de Jev 1.13](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

La confiance est dérivée de la distribution des réponses ; elle n'est pas un taux de justesse vérifié sur nos factures. Les seuils doivent dépendre de la conséquence de l'action et du corpus évalué. Un seuil élevé ne remplace aucune permission. [Confiance](https://docs.typesafe.ai/confidence).

### Conséquences proposées pour l'adaptation US

| Champ/action | Traitement proposé, à implémenter/valider |
|---|---|
| Catégorie | Choix fermé : facture fournisseur, devis, avoir, reçu, rappel, autre, incertain ; distinguer vendeur et destinataire. |
| Nom/référence | Copier un candidat sourcé ; le nom affiché de l'expéditeur ne prouve pas une identité fournisseur. |
| Montants | Conserver le texte source et sa localisation ; normalisation en chaînes d'unités mineures USD, contrôles en arithmétique entière. Aucun zéro par défaut. |
| Taxe imprimée | Sélection d'un montant présent. Aucun calcul automatique de sales tax, nexus, exonération, use tax ou droit à déduction. |
| Devise | USD explicite pour l'ERP US actuel. `$` seul, devise absente ou multidevise : revue ; aucune conversion inventée. |
| Dates | Distinguer émission, échéance, date comptable et paiement. `03/04/2026` sans convention probante reste ambigu ; ne pas imposer JJ/MM ou MM/DD à partir de la seule langue UI. |
| PDF/image | PDF texte pris en charge par le préparateur vérifié ; image/PDF scanné sans texte : saisie/revue. Aucun fournisseur OCR ajouté dans ce lot. |
| Fournisseur | Proposer un fournisseur du même espace, puis confirmation. Création après informations requises vérifiées ; pas de fausse adresse ni de rapprochement par nom seul. |
| Fraude/injection | Le document ne peut choisir le tenant, changer les coordonnées bancaires, attribuer un rôle ou déclencher un paiement. |

## 3. IRS : justificatifs et séparation des dates

La publication 583, révision décembre 2024, décrit les factures et autres pièces comme justificatifs des livres. Le stockage électronique doit permettre leur indexation, préservation, recherche et reproduction lisible, avec des données complètes et accessibles. Une extraction de quelques montants ne démontre pas que l'original peut être supprimé. [IRS Publication 583, sections Electronic records / Supporting Documents](https://www.irs.gov/publications/p583).

**Décision d'architecture proposée :** garder le justificatif source dans un stockage privé autorisé, relié à la proposition puis à la facture ; enregistrer son empreinte, sa provenance et la revue. L'accès au justificatif doit vérifier l'appartenance courante à l'espace. Le lien `sourceReference` d'une écriture n'est pas à lui seul un système d'archivage ni une preuve de conformité IRS.

Il n'existe pas dans ces sources de durée unique applicable à tous les documents. L'IRS cite notamment des périodes différentes selon la déclaration, les pertes, les omissions, l'emploi ou les actifs, ainsi que des besoins non fiscaux. Le délai est souvent lié à la déclaration ou à la cession, pas à la réception de l'e-mail. [IRS — durée de conservation](https://www.irs.gov/businesses/small-businesses-self-employed/how-long-should-i-keep-records).

**À définir avec un professionnel :** catégories de conservation, événement de départ, exceptions, obligations d'État/secteur/contrat, gel juridique et suppression des copies temporaires. Ne pas implémenter une purge universelle à trois ou sept ans. Distinguer l'original comptable, le mail périphérique, les extraits envoyés au moteur et les logs techniques.

La publication 538, révision janvier 2022 actuellement servie par l'IRS, distingue généralement l'encaissement/décaissement en cash basis et l'acquisition/engagement en accrual basis. Les dépenses en accrual impliquent notamment le test des événements et la réalisation économique ; il existe des exceptions et règles de capitalisation. Une facture reçue n'établit donc pas à elle seule la déductibilité ou la période fiscale correcte. [IRS Publication 538, Accounting Methods / Expenses](https://www.irs.gov/publications/p538).

**Conséquence proposée :** l'analyse suggère les faits du document, mais ne choisit ni la méthode de l'entreprise ni la période ouverte. Le reviewer valide la date comptable et la nature de l'achat. Un paiement ultérieur reste une action distincte. Le traitement fiscal des immobilisations, charges payées d'avance, stocks, parties liées et autres exceptions reste hors automatisation du premier lot.

## 4. Minimisation, B2B et transferts

### E-mails B2B US

La FTC recommande de cartographier les données, de limiter la collecte à ce qui est nécessaire, de restreindre les accès et de définir une politique de conservation/destruction adaptée. Elle distingue les obligations selon le type de données et de métier ; un chiffrement seul ne remplace pas ces choix. [FTC — protection des informations](https://www.ftc.gov/business-guidance/resources/protecting-personal-information-guide-business).

La CPPA précise que les personnes concernées peuvent inclure des contacts de clients/fournisseurs professionnels et que les anciennes exemptions B2B ont expiré fin 2022. L'application du CCPA dépend des critères applicables ; les prestataires/contractants peuvent avoir des obligations distinctes. « C'est du B2B » ne suffit donc pas à exclure la protection des données. [CPPA — FAQ, Who has privacy rights / Who must comply / B2B exemptions](https://cppa.ca.gov/faq.html).

**Proposition de minimisation :** ne transmettre que les passages nécessaires à la facture et les candidats utiles du même espace. Retirer les fils anciens, destinataires inutiles, signatures, jetons, mots de passe, SSN, numéros complets de carte et informations médicales non requises. Garder les logs sans corps de mail ni clé ; journaliser identifiants opaques, état, version de politique/modèle, durée et codes bornés. Les diagnostics privés nécessaires à une revue ne doivent pas être des logs publics.

Ce contrôle doit préserver les passages justificatifs utiles : masquer à l'aveugle un montant ou le nom du vendeur rendrait l'extraction invérifiable. Les e-mails pouvant contenir des données réglementées doivent être mis hors de ce flux initial tant que leur traitement n'est pas évalué. Aucune affirmation générale HIPAA, SOC 2, CCPA ou protection « US complète » n'est justifiée par cette recherche.

### TypeSafe : engagements publics et inconnues du compte

Le DPA public TypeSafe est daté du 24 avril 2026. Il décrit les instructions documentées, les rôles controller/processor, l'encadrement des sous-traitants et des transferts, et une conservation liée aux finalités et lois ; il ne donne pas un délai numérique universel. Son annexe indique les données sensibles comme non applicables. Son applicabilité exacte à notre contrat et aux données envisagées doit être vérifiée. [DPA TypeSafe](https://typesafe.ai/legal/data-processing).

La politique publique affirme ne pas entraîner/ajuster les modèles sur les entrées et indique un hébergement aux États-Unis. Cette déclaration ne prouve ni une région contractuelle dédiée, ni une absence de stockage, ni une certification. [Politique TypeSafe](https://typesafe.ai/legal/privacy-policy). La documentation présente la rétention zéro comme une offre pour les clients entreprise : aucun bénéfice ZDR de notre compte n'a été vérifié. [Documents légaux TypeSafe](https://docs.typesafe.ai/legal).

Le DPA renvoie à une liste de sous-traitants. La page a été ouverte mais son contenu exploitable n'a pas été retourné par l'outil de lecture : **liste, pays et traitements non vérifiés dans ce relevé**. [Trust Center — sous-traitants](https://trust.typesafe.ai/subprocessors). Aucun accès privé ou contact commercial n'a été utilisé pour combler ce manque.

### Exploitant suisse et hébergement hors US

Le PFPDT décrit les conditions des transferts depuis la Suisse : adéquation ou garanties appropriées, examen du destinataire et transparence ; le registre doit tenir compte des pays/garanties lorsqu'il est requis. Le cadre Swiss-U.S. ne signifie pas que toute entreprise américaine est adéquate sans vérifier les conditions applicables. [PFPDT — communication à l'étranger](https://www.edoeb.admin.ch/fr/communication-de-donnees-a-letranger).

**À valider avant activation réelle :** chaîne entreprise cliente → Zentra → hébergeur/connecteur → TypeSafe/sous-traitants, rôles contractuels, pays de stockage et d'accès support, mécanisme de transfert, contrats et information des personnes. La région existante de la base et l'accès des prestataires n'ont pas été vérifiés ici. Cette phase ne propose aucun déplacement de données. Des messages provenant de personnes UE/UK peuvent demander un examen supplémentaire ; l'adresse de l'entreprise US ne résout pas tout le champ d'application.

## 5. Points d'appui et frontières dans le code actuel

Constats **de source**, pas preuves de fonctionnement en production :

| Source relue | Réemploi / limite |
|---|---|
| `lib/automation/provider.ts:13`, `:81` ; `lib/automation/transport.ts` | Modèle épinglé et adapter HTTP réutilisables. Ne pas ajouter un fournisseur au client natif ni exposer sa clé. |
| `lib/automation/execution.ts:12`, `:34` | Droits Automation, consentement, flags et contrôle frais à chaque tentative existent. Les garder avant/après toute analyse US et avant effet ERP. |
| `lib/automation/invoice-scan.ts:12`, `:42–50` | Le scan existant produit une suggestion à confirmer, jamais une écriture ou un paiement. Son accès d'analyse inclut member ; ce rôle ne doit pas devenir une autorité financière US. |
| `lib/supplier-inbox/documents.ts:3`, `:17` ; `lib/support/mail-documents.ts:4` | Préparation bornée de PDF texte : limite de 6 MiB/12 pages, extraction temporisée ; pas d'OCR d'image. Pièce incomplète/illisible demande revue. |
| `lib/supplier-inbox/extraction.ts:34–46`, `:149–151`, `:213–251` | Dates locales interprétées JJ/MM ; champs TVA/taux unique ; devise non CHF signalée manuelle. **Ne pas modifier ces règles CH dans ce lot ; ne pas les prétendre adaptées US.** |
| `lib/international/purchasing.ts:128–143` | BillInput USD, chaînes mineures exactes, fournisseur de l'espace, approbation humaine et taxe d'achat imprimée. `approvalSource` actuel reste `manual_entry`, compte d'achat actuel `purchases` ; aucune fausse prise en charge générale des catégories comptables. |
| `lib/international/runtime.ts:158–170` | Commande `record_vendor_bill` avec rôle financier frais, fournisseur enregistré, période ouverte et contrôle doublon. Réutiliser la même enveloppe/idempotence/CAS, pas une écriture directe du connecteur. |
| `lib/international/accounting/postings.ts:64–82` | En accrual, facture vers charge/dette ; en cash, journal au paiement. La taxe d'achat est incluse au coût par le code existant, sans crédit TVA. C'est un traitement d'implémentation limité, pas une garantie de déductibilité ni US GAAP. |

## 6. Premier jalon recommandé et critères de recette

Ce plan est une recommandation d'implémentation, **pas une fonctionnalité livrée par ce document**.

1. Une connexion Support autorisée fournit un mail/justificatif de l'espace US réel ; aucune organisation choisie dans le contenu du mail. Garder les références de provenance et les originaux privés.
2. Une analyse éligible prépare un résultat strict, borné et sourcé, avec versions de document/politique/modèle, empreinte et contexte entreprise. Distinguer absent, ambigu, non pris en charge et erreur fournisseur.
3. Sauvegarder une proposition d'achat séparée du journal ; créer/choisir le fournisseur du même espace. Présenter original, champs et raisons de revue dans une interface de confirmation.
4. Seul owner/admin/accountant autorisé peut confirmer vers `record_vendor_bill`. Vérifier identité, espace, droits Gestion/Automation, période et révision **au moment de confirmer**. Une nouvelle analyse ne donne aucune nouvelle permission.
5. En cas de réponse perdue, reprendre la même enveloppe financière exacte ; aucune nouvelle clé tant que le résultat reste incertain. Les changements d'acteur/espace purgent les brouillons et reprises conformément à la frontière existante.
6. Relier le reçu ERP à la proposition sans prendre un reçu historique pour l'état courant. Conserver l'audit des décisions/corrections et la preuve originale ; annuler la proposition n'annule pas silencieusement une écriture déjà confirmée.

Recette minimale proposée : facture USD explicite ; date MM/DD sans ambiguïté puis `03/04` ambigu ; plusieurs montants et taxes imprimées ; absence de taxe vs zéro explicitement imprimé ; devis/avoir/rappel/reçu séparés ; document scanné illisible ; mauvaise entreprise destinataire ; injection dans texte et pièces jointes ; fournisseur absent/homonyme ; perte de réponse et rejeu exact sans doublon ; révocation de rôle/droit pendant analyse ; période fermée après revue ; cash/accrual et paiements partiels ; autre tenant inaccessible ; original récupérable ; aucune clé/corps de mail dans les logs.

Les tests de transport peuvent injecter des réponses simulées et les tests métier utiliser le vrai moteur/CAS avec des données fictives. Ils ne prouveront pas la précision réelle de Jev, un OCR, la connexion d'un compte de messagerie, la charge multi-clients ou la conformité juridique. Une évaluation fournisseur réelle devra être autorisée séparément, avec corpus licite/minimisé et métriques par champ/classe, sans gain de temps ou pourcentage commercial inventé.

## 7. Méthode et éléments non vérifiés

- Le skill fournisseur `stripe-directory` a été lu en premier. La CLI Directory est absente ; la page publique renvoie vers sa documentation. Aucun catalogue authentifié n'a été exécuté ni outil installé dans ce périmètre limité à un document. Les conclusions TypeSafe reposent sur ses pages officielles, pas sur une validation du catalogue ou de notre compte.
- L'index officiel [TypeSafe llms.txt](https://docs.typesafe.ai/llms.txt) a servi à trouver les recettes existantes ; aucune API « extraction facture libre » n'a été supposée à partir d'un nom d'URL.
- Aucune valeur de prix, de débit garanti, de rétention universelle, de certification, de sales tax automatique ou de région contractuelle propre au compte n'est proposée.
- Aucun test logiciel, appel payant ou transfert réel n'a été exécuté pour cette recherche. Les sources métier sont relues au HEAD indiqué ; les décisions réglementaires complexes restent à valider avant une activation réelle.
