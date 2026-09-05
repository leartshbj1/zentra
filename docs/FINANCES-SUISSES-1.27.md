# Finances suisses dans Zentra 1.27

Sources officielles consultées le 5 septembre 2026. Cette évolution facilite la tenue des factures et la préparation des états; elle ne constitue pas une certification de conformité couvrant toutes les situations fiscales suisses.

## Factures, références et relevés bancaires

Les listes de devis et de factures, y compris dans les dossiers des projets, présentent les dates de document les plus récentes en premier. À date égale, la création la plus récente passe devant.

À l'émission d'une nouvelle facture suisse éligible, Zentra crée une référence de paiement et l'intègre dans la QR-facture et son PDF. Un QR-IBAN utilise une référence QRR à 27 chiffres; un IBAN ordinaire utilise une référence RF de type SCOR. Ces deux combinaisons correspondent au [standard de la QR-facture SIX](https://www.six-group.com/fr/products-services/banking-services/billing-and-payments/qr-bill.html). Les coordonnées et la référence sont figées avec la facture. Les anciennes factures émises et les instructions QR explicitement préparées dans un brouillon sont conservées. La génération automatique actuelle couvre CHF avec un IBAN suisse ou liechtensteinois, ainsi qu'EUR avec un IBAN ordinaire; les avoirs n'appellent pas de paiement.

Dans **Banque**, importez le fichier **camt.053 XML** exporté par votre banque. L'option de rapprochement automatique est activée par défaut et peut être désactivée. Le compte du relevé doit être associé à l'entreprise et la comptabilité configurée.

Une référence structurée exacte et unique, une écriture bancaire comptabilisée, une devise identique et un montant compatible permettent d'enregistrer le paiement et son écriture comptable ensemble. Un règlement partiel laisse la facture partiellement payée; le dernier règlement la passe en payée. Les réimports ne créent pas de deuxième paiement. Les références ambiguës, excédents, annulations et mouvements provisoires restent à contrôler. Les avis camt.052/054 peuvent être lus mais n'apportent pas à eux seuls la preuve finale requise par cette fonction. Aucun virement bancaire n'est envoyé.

## TVA due et TVA récupérable

L'AFC indique actuellement les taux de **8,1 %, 2,6 % et 3,8 %**. Les TDFN et TaF comprennent le traitement de l'impôt préalable dans leur méthode: il ne faut pas déduire une seconde fois la TVA des achats. [Taux et méthodes AFC](https://www.estv.admin.ch/fr/taux-de-la-tva-suisse).

1. Activez la TVA dans les paramètres de l'entreprise puis configurez **Comptabilité → TVA → Méthode & autorisation** selon votre régime réellement déclaré.
2. Saisissez les factures fournisseurs et joignez les justificatifs. Le champ **Traitement TVA de ces achats** permet de classer les marchandises et prestations au chiffre 400, les investissements et autres charges au chiffre 405, ou de signaler l'absence de droit à déduction. Ce choix concerne toutes les lignes du brouillon; les traitements mixtes se précisent ligne par ligne dans le décompte.
3. Validez les pièces puis choisissez une période dans **Comptabilité → TVA**. Le récapitulatif présente la TVA sur les ventes, l'impôt préalable net récupérable et le solde à payer ou le crédit. Les corrections, réductions et l'impôt sur les acquisitions entrent dans le calcul.
4. Traitez les sources non classées et les anomalies avant l'export XML. Le fichier est ensuite importé et contrôlé dans Décompte TVA pro; Zentra ne le transmet pas à l'AFC. [Services de décompte AFC](https://www.estv.admin.ch/fr/taxe-sur-la-valeur-ajoutee).

Les dépenses privées ne deviennent pas déductibles du seul fait qu'elles sont enregistrées. Les affectations mixtes et les réductions nécessitent une clé et des preuves appropriées. L'AFC demande les pièces fournisseurs et le contrôle de concordance annuel; les différences se corrigent dans le décompte de la période comprenant le 180e jour après la fin de l'exercice. [Contrôle TVA et finalisation, AFC](https://www.estv.admin.ch/fr/deroulement-dun-controle-tva).

Le moteur refuse encore certains cas plutôt que produire un décompte incomplet: allocations de paiements partiels sur plusieurs périodes en mode «reçues», certains avoirs fournisseurs avec TVA, ou devises sans conversion comptable justifiée. Les points sont affichés et bloquent l'XML. Les choix TVA ne remplacent pas les écritures de reclassement comptable nécessaires pour les dépenses privées ou les corrections de fin d'année.

## Bilan et résultat exportables

Dans **Comptabilité**, choisissez l'exercice puis **Bilan**, **Résultat** ou **Dossier de clôture**, et cliquez sur **Exporter le bilan en PDF**. Le fichier rassemble les actifs circulants et immobilisés, les dettes à court et long terme, les fonds propres et résultats, puis les produits, charges et bénéfice/perte. Il compare la période avec N-1 et affiche les contrôles d'équilibre. Cette organisation reprend les catégories du [bilan-type du Portail PME du SECO](https://www.kmu.admin.ch/fr/bilan-type-dune-entreprise-constituer-et-lire-un-bilan), avec les chiffres du journal de l'entreprise.

L'exercice ouvert porte la mention «Provisoire». Un exercice comptable clôturé porte la mention correspondante. Une erreur de conversion de devises interrompt l'export et conserve le fichier précédent. Le dossier fiduciaire existant apporte aussi les états CSV/JSON et les contrôles de clôture. L'annexe aux comptes, l'approbation et les documents propres à la forme juridique restent à joindre selon les obligations de l'entreprise. Le PDF d'exemple produit pendant la recette contient exclusivement des chiffres fictifs.

Les menus Comptabilité et TVA sont des listes de sections sur téléphone et des onglets navigables au clavier sur ordinateur.
