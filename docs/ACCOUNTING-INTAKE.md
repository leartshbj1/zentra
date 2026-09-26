# Immobilisations et scan des factures fournisseurs

Relevé du 26 septembre 2026, pour l’application 1.89.0 en préparation. Le handoff final annonce le serveur Automation publié en version 264, depuis la source `2b165764`. Cette publication du serveur ne prouve ni la livraison de l’application 1.89.0, ni une validation sur téléphone physique.

## Enregistrer une immobilisation

Ouvrez **Comptabilité → Immobilisations**, puis **Ajouter un bien**. La comptabilité doit être activée dans **Plan et liaisons**, et votre accès doit autoriser l’écriture.

1. Saisissez le nom du bien, la référence d’achat, la date réelle d’acquisition et le coût en CHF. Le coût demandé exclut la TVA récupérable et inclut la TVA non récupérable.
2. Choisissez l’origine de l’achat, puis les comptes concernés.
3. Vérifiez la méthode d’amortissement, le taux annuel, la valeur résiduelle et le compte de charge d’amortissement.
4. Cochez la confirmation correspondant à l’origine de l’achat, puis cliquez sur **Enregistrer le bien**. Une modification des données retire cette confirmation.

| Origine choisie | Écriture préparée |
| --- | --- |
| **Oui, reclasser cet achat** | Débit du compte d’immobilisation, crédit de la charge dans laquelle le coût a déjà été enregistré. Vous confirmez cette comptabilisation préalable. |
| **Non, achat bancaire sans TVA** | Débit du compte d’immobilisation, crédit du compte bancaire de liaison. Vous confirmez que cet achat sans TVA n’a pas encore été comptabilisé. Ce choix ne déclenche aucun paiement bancaire. |

Pour une facture avec TVA, le parcours prévu est d’enregistrer d’abord l’achat dans **Achats et fournisseurs**, puis de reclasser son coût. L’immobilisation ne passe aucune écriture de TVA et ne la déduit donc pas une seconde fois. Elle ne retrouve pas automatiquement une facture par sa référence : le choix de la charge et la confirmation d’origine restent manuels.

Si les comptes nécessaires manquent, **Ajouter les comptes nécessaires** propose les comptes 1500 « Immobilisations corporelles » et 6800 « Amortissements ». Un compte actif remplissant déjà ce rôle est conservé ; un numéro existant avec un autre usage provoque un message à résoudre dans le plan comptable.

## Amortir ou annuler un bien

Le registre affiche le coût d’acquisition, le montant déjà amorti et la valeur comptable. Le calcul natif applique le taux au coût initial en méthode linéaire, ou à la valeur restante en méthode dégressive. La première année est calculée au prorata des jours depuis l’acquisition ; le cumul est plafonné pour préserver la valeur résiduelle.

Les présélections Informatique, Mobilier, Machines et Véhicules sont présentées comme des **taux indicatifs AFC**, modifiables selon le bien et le canton. Elles ne déterminent pas à elles seules le traitement fiscal applicable. Les terrains ne sont pas pris en charge par ce formulaire.

Cliquez sur **Amortissement [année]**, vérifiez le montant et la date du 31 décembre proposés, puis sur **Confirmer l’écriture**. L’ouverture de la confirmation ne comptabilise rien. Chaque année est traitée dans l’ordre ; aucun amortissement automatique n’est lancé. Le moteur vérifie à nouveau le montant avant l’écriture et refuse une demande devenue incohérente.

Avant tout amortissement, **Annuler le bien** permet de confirmer une écriture inverse à la date du jour et de conserver le bien dans **Biens annulés**. Après un amortissement, cette annulation simple est refusée : une correction comptable doit être préparée. Une écriture extournée ou une acquisition absente bloque également les opérations du registre.

L’enregistrement du bien est conservé dans le journal d’audit ; acquisitions, amortissements et annulations utilisent le journal comptable existant. Ces données appartiennent à la sauvegarde et à l’échange de l’entreprise dans le **schéma 60**, sans registre privé séparé. Les demandes identiques déjà enregistrées sont reconnues, et un bien actif portant le même nom et la même référence est refusé. En cas de modifications concurrentes du même bien sur deux appareils, le code de fusion refuse la fusion automatique et demande de vérifier les versions afin d’éviter une double écriture ; ce cas fait encore l’objet de la relance native mentionnée ci-dessous.

## Préparer une facture à partir d’un PDF ou d’une photo

Dans la première étape d’une **Nouvelle facture fournisseur**, **Scanner une facture** apparaît lorsque la fonction correspondante d’Automation est disponible et activée pour l’entreprise. La saisie manuelle reste le parcours de reprise lorsque la lecture n’est pas disponible.

1. Sélectionnez un PDF, PNG, JPEG ou WebP, de moins de 20 Mo. Un PDF textuel peut contenir jusqu’à 12 pages ; un PDF nécessitant l’OCR est limité à 4 pages. Un fichier trop peu lisible ou contenant trop de texte est refusé.
2. Zentra extrait le texte localement. Pour une photo ou un PDF image, l’OCR est exécuté localement ; le texte obtenu est ensuite transmis au serveur **Automation** pour analyse. Cette analyse demande donc une connexion et la disponibilité du service ; le flux n’est pas entièrement hors ligne.
3. Vérifiez la proposition : fournisseur, référence, date, échéance, total et éventuels points à corriger. **Voir le document original** permet de comparer avec la source.
4. Cliquez sur **Utiliser ces informations** pour reprendre les données dans le formulaire. Une proposition ne devient pas automatiquement une facture enregistrée.
5. Complétez les champs, les lignes, les comptes et le traitement TVA, puis suivez la vérification et l’enregistrement du brouillon fournisseur existants.

La reprise remplit les champs de fournisseur, référence, dates et lignes préparées. Le clic explicite sur Utiliser ces informations remplace les champs concernés. Un changement d’entreprise annule la proposition en cours. Le fournisseur est présélectionné seulement si son nom correspond à un unique fournisseur actif ; sinon, il reste à choisir. Aucun fournisseur n’est créé par cette reprise.

Seule une proposition identifiée comme facture fournisseur en CHF peut être appliquée. Une ligne récapitulative est préparée lorsque net, TVA, total et taux sont cohérents ; les taux reconnus pour cette vérification sont 0 %, 2,6 %, 3,8 % et 8,1 %. Une facture à plusieurs taux ou des montants incohérents laisse les lignes à compléter. Le scan ne déduit jamais la récupérabilité de la TVA à partir du taux imprimé : le traitement TVA est remis à vérifier dans le formulaire.

## Conserver l’original

Après l’enregistrement du brouillon, le fichier source sélectionné est ajouté à ses justificatifs par `add_scanned_supplier_attachment`. Le stockage existant contrôle le fichier et son empreinte avant de le conserver ; il ne s’agit pas seulement du texte extrait.

Si le brouillon est enregistré mais que la pièce jointe échoue, un message signale le justificatif restant à joindre. Le fichier reste disponible dans la saisie courante pour réessayer avec **Joindre [nom du fichier]**. Une simple lecture ou un clic sur **Utiliser ces informations** ne prouve pas que l’original est archivé : vérifiez la réussite de l’enregistrement et de l’ajout du justificatif.

Le scan prépare un brouillon. Il ne valide pas automatiquement la facture, ne comptabilise pas son achat et ne déclenche aucun paiement.

## Preuves et limites

Les [quatre parcours navigateur](../.impeccable/review/accounting-intake/results.json), Edge et WebKit à 390 px sombre et 1440 px clair, vérifient un enregistrement dans la fixture, la confirmation explicite de l’amortissement, la lecture du texte d’un PDF de test et l’application volontaire de la proposition. Ils ne signalent ni erreur JavaScript ni débordement horizontal.

Ces parcours simulent les écritures et la réponse Automation. Ils ne prouvent ni les calculs natifs à partir des montants affichés dans les captures, ni l’OCR d’une vraie photo, ni la qualité d’un fournisseur d’analyse réel, ni l’archivage complet du justificatif dans le parcours installé. Aucun essai sur téléphone physique n’est établi. Les nouveaux textes de ces panneaux sont en français.

Le handoff annonce la disposition **ship** du reviewer pour les écrans examinés. Le test natif de collision entre appareils a détecté un panic ; sa correction est annoncée, mais la nouvelle exécution CI reste à vérifier dans ce relevé. Aucune réussite globale des tests natifs n’est annoncée ici. La [note de comparaison visuelle](../.impeccable/review/accounting-intake/documentation.md) précise les douze captures et la portée du verdict.

Sources : [panneau des immobilisations](../desktop/src/FixedAssetsPanel.tsx), [présélections et API](../desktop/src/fixedAssets.ts), [registre natif](../desktop/src-tauri/src/fixed_assets.rs), [lecture et reprise du scan](../desktop/src/invoiceScan.ts), [panneau de vérification](../desktop/src/InvoiceScanPanel.tsx), [assistant fournisseur](../desktop/src/SupplierInvoiceWizard.tsx), [commande de pièce jointe](../desktop/src-tauri/src/commands.rs), [stockage des justificatifs](../desktop/src-tauri/src/attachments.rs), [fusion](../desktop/src-tauri/src/company_merge.rs).
