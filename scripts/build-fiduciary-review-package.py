"""Build a reproducible, fictitious professional acceptance dossier (CHF cents)."""
from pathlib import Path
import json
from html import escape
from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "pdf"
OUT.mkdir(parents=True, exist_ok=True)
pdfmetrics.registerFont(TTFont("Review", "C:/Windows/Fonts/arial.ttf"))
pdfmetrics.registerFont(TTFont("ReviewBold", "C:/Windows/Fonts/arialbd.ttf"))
pdfmetrics.registerFontFamily("Review", normal="Review", bold="ReviewBold")
GREEN = colors.HexColor("#173d2c")
MUTED = colors.HexColor("#5f6962")
GOLD = colors.HexColor("#9b7534")
PALE = colors.HexColor("#eef2e9")
styles = {
    "title": ParagraphStyle("title", fontName="ReviewBold", fontSize=27, leading=31, textColor=GREEN, spaceAfter=15),
    "h2": ParagraphStyle("h2", fontName="ReviewBold", fontSize=15, leading=19, textColor=GREEN, spaceBefore=15, spaceAfter=8),
    "body": ParagraphStyle("body", fontName="Review", fontSize=10.3, leading=15, textColor=GREEN, spaceAfter=9),
    "small": ParagraphStyle("small", fontName="Review", fontSize=9, leading=12.5, textColor=MUTED, spaceAfter=7),
    "cell": ParagraphStyle("cell", fontName="Review", fontSize=9.4, leading=13, textColor=GREEN),
}
def p(text, kind="body"):
    return Paragraph(text, styles[kind])
def table(rows, widths):
    data = [[p(escape(str(value)), "cell") for value in row] for row in rows]
    t = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), PALE), ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("LINEBELOW", (0,0), (-1,0), 0.8, colors.HexColor("#b9c8bd")),
        ("LINEBELOW", (0,1), (-1,-1), 0.4, colors.HexColor("#d9dfd4")),
        ("TOPPADDING", (0,0), (-1,-1), 8), ("BOTTOMPADDING", (0,0), (-1,-1), 8),
        ("LEFTPADDING", (0,0), (-1,-1), 9), ("RIGHTPADDING", (0,0), (-1,-1), 9),
    ]))
    return t
def chf(cents):
    return f"{cents / 100:,.2f}".replace(",", "'")
def vat(base, bp=810):
    return (base * bp + 5000) // 10000

sale, purchase, customer_credit, supplier_credit = 100000, 40000, 10000, 5000
output_vat = vat(sale) - vat(customer_credit)
input_vat = vat(purchase) - vat(supplier_credit)
net_vat = output_vat - input_vat
profit = sale - customer_credit - purchase + supplier_credit
bank = 1000000 + sale + vat(sale) - purchase - vat(purchase) - customer_credit - vat(customer_credit) + supplier_credit + vat(supplier_credit)
assets = bank + input_vat
liabilities_equity = output_vat + 1000000 + profit
assert (output_vat, input_vat, net_vat, profit, bank, assets) == (7290, 2835, 4455, 55000, 1059455, 1062290)
assert assets == liabilities_equity
gross = 600000
monthly = {"AVS/AI/APG (5,3 %)": vat(gross,530), "AC (1,1 %)": vat(gross,110), "AANP (hypothèse 1 %)": 6000, "IJM (hypothèse 0,5 %)": 3000, "LPP (hypothèse forfaitaire)": 25000}
cash_net = gross - sum(monthly.values())
annual_gross = gross * 12
certificate_9 = (monthly["AVS/AI/APG (5,3 %)"] + monthly["AC (1,1 %)"] + monthly["AANP (hypothèse 1 %)"]) * 12
certificate_10 = monthly["LPP (hypothèse forfaitaire)"] * 12
certificate_net = annual_gross - certificate_9 - certificate_10
assert (cash_net, certificate_9, certificate_10, certificate_net) == (527600, 532800, 300000, 6367200)
expected = {
    "status": "expected_only_requires_professional_execution", "date": "2026-09-08", "currency": "CHF", "unit": "cents",
    "ledger_case": {"sales_net":90000,"purchases_net":35000,"vat_due":output_vat,"vat_recoverable":input_vat,"vat_payable":net_vat,"profit_before_tax":profit,"bank":bank,"assets_with_vat_unoffset":assets,"liabilities_and_equity_with_vat_unoffset":liabilities_equity},
    "deposit_case": {"quote_gross":108100,"deposit_gross":32430,"balance_gross":75670,"total_vat":8100},
    "salary_case": {"monthly_gross":gross,"monthly_cash_net":cash_net,"annual_cash_net":cash_net*12,"certificate_1":annual_gross,"certificate_8":annual_gross,"certificate_9":certificate_9,"certificate_10_1":certificate_10,"certificate_11":certificate_net,"ijm_excluded_from_certificate_9":36000},
}
target = ROOT / "docs" / "recette-fiduciaire"
target.mkdir(parents=True, exist_ok=True)
(target / "attendus.json").write_text(json.dumps(expected, ensure_ascii=False, indent=2)+"\n", encoding="utf8")

story = [p("Zentra<br/>Dossier de recette fiduciaire", "title"), p("8 septembre 2026 - cas fictifs à contrôler", "h2")]
story += [p("<b>Objectif :</b> comparer les résultats produits par Zentra à des chiffres attendus explicites, puis faire signer une appréciation par la fiduciaire. Ce dossier n’atteste ni une validation professionnelle déjà obtenue, ni une certification Swissdec."),
    p("Les montants de ce dossier sont des <b>résultats attendus calculés indépendamment</b>, pas des exports présentés comme issus d’une session de recette. Chaque cas doit être exécuté dans une entreprise de test distincte. Ne saisir aucune donnée réelle de salarié ou de client."),
    table([["Périmètre", "Pièces à joindre après exécution"],
           ["Ventes, achats et TVA", "Factures, avoirs, justificatifs d’achat, décompte TVA et grand livre."],
           ["Acompte et banque", "Dossier devis/acompte/solde, références bancaires, import initial et rejeu."],
           ["Paie et certificat annuel", "12 fiches payées, cumuls, certificat officiel et détail des classifications."],
           ["Fin d’exercice", "Balance, bilan, résultat, piste d’audit et archive de clôture."],
           ["Reprise et collaboration", "Copie restaurée, empreintes des pièces et relevé des conflits éventuels."]], [152,347]),
    p("Périmètre de la version examinée", "h2"),
    p("Le site de récupération a été publié le 8 septembre. Les installateurs actuellement annoncés restent en version 1.45.0. Les corrections natives de sauvegarde et la numérotation partagée sont en préparation ; la réplication métier complète n’est pas encore active."),
    p("Vendeur communiqué : Shabija Leart, non assujetti à la TVA ; support : leartshabija@gmail.com. L’adresse professionnelle reste à fournir. Ce statut concerne la vente de Zentra et ne remplace pas le profil TVA de chaque entreprise cliente.", "small"), PageBreak()]

story += [p("01 / TVA et fin d’exercice", "title"), p("Entreprise de test assujettie, méthode effective sur contre-prestations convenues, CHF, exercice 2026. Solde initial : banque 10'000.00 et capital 10'000.00. Les achats sont entièrement consommés ; aucun stock final, aucun autre produit, aucune autre charge, aucun impôt sur le bénéfice dans ce cas."),
    table([["Opération de janvier", "HT", "TVA 8,1 %", "TTC"],
        ["Vente facturée puis encaissée",chf(sale),chf(vat(sale)),chf(sale+vat(sale))],
        ["Achat validé puis payé",chf(purchase),chf(vat(purchase)),chf(purchase+vat(purchase))],
        ["Avoir client puis remboursement",chf(customer_credit),chf(vat(customer_credit)),chf(customer_credit+vat(customer_credit))],
        ["Avoir fournisseur puis remboursement reçu",chf(supplier_credit),chf(vat(supplier_credit)),chf(supplier_credit+vat(supplier_credit))]], [240,85,85,89]),
    p("Soldes attendus après les quatre opérations", "h2"),
    table([["Contrôle", "CHF"], ["Chiffre d’affaires net / achats nets", "900.00 / 350.00"], ["Résultat avant impôt",chf(profit)], ["TVA due / impôt préalable récupérable",f"{chf(output_vat)} / {chf(input_vat)}"], ["TVA nette à payer",chf(net_vat)], ["Banque / clients ouverts / fournisseurs ouverts",f"{chf(bank)} / 0.00 / 0.00"], ["Actif total (TVA présentée sans compensation)",chf(assets)], ["Passif + capital + résultat (sans compensation TVA)",chf(liabilities_equity)]], [365,134]),
    p("Si la TVA est présentée nette au bilan : actif banque 10'594.55 = TVA nette 44.55 + capital 10'000.00 + résultat 550.00. Les deux présentations doivent être rapprochables. Exporter la balance, le bilan et le résultat, puis vérifier chaque ligne du journal et la conservation des pièces originales.", "small"),
    p("Références : taux officiels AFC [1], principes TVA et déduction de l’impôt préalable [2]. Ce cas suppose un droit intégral à déduction et ne couvre ni usage privé, ni exclusion du champ de l’impôt, ni TDFN.", "small"), PageBreak()]

story += [p("02 / Acompte, banque et corrections", "title"),
    p("Créer un autre projet et un devis de 1'000.00 HT, TVA 81.00, soit 1'081.00 TTC. Prévoir un acompte de 30 %. Le traitement de l’avance avant réalisation de la prestation doit être confirmé selon la méthode de décompte de l’entreprise."),
    table([["Étape", "Résultat à contrôler"], ["Acompte", "300.00 HT + 24.30 TVA = 324.30 TTC."], ["Solde", "700.00 HT + 56.70 TVA = 756.70 TTC."], ["Dossier du projet", "Devis, facture d’acompte et facture de solde reliés ; l’acompte reste visible."], ["Total économique", "1'000.00 HT, 81.00 TVA et 1'081.00 TTC au total après réalisation ; aucun double comptage."], ["Import bancaire 1", "Le paiement 324.30 correspond à la référence de l’acompte ; seul cet acompte est soldé."], ["Import bancaire 2", "Le paiement 756.70 correspond au solde ; les deux factures sont ensuite soldées."], ["Rejeu du même relevé", "Aucun nouveau paiement, aucune nouvelle écriture, aucun changement de montant."], ["Référence absente ou ambiguë", "Proposition à confirmer ; ne pas solder automatiquement une facture arbitraire."], ["Paiement partiel ou excédentaire", "Solde exact visible ; excédent ou crédit client traité explicitement, sans perdre la différence."]], [148,351]),
    p("Contrôles complémentaires", "h2"),
    p("Émettre un avoir après clôture d’une première période : la correction doit conserver l’original et apparaître à sa propre date. Essayer ensuite de supprimer ou de modifier une facture émise et une écriture validée : le refus doit préserver l’historique."),
    p("Tester séparément la méthode sur contre-prestations reçues, les achats partiellement déductibles et les TDFN. Ne pas appliquer automatiquement les attendus du cas 01 à ces méthodes : leur traitement et les périodes exigibles doivent être validés par la fiduciaire.", "small"), PageBreak()]

story += [p("03 / Paie et certificat annuel", "title"),
    p("Salarié fictif de 35 ans, employé toute l’année 2026 à temps plein, 12 salaires mensuels de 6'000.00 ; pas de 13e salaire, avantage en nature, allocation, frais ou impôt à la source. Toutes les fiches sont payées pendant 2026. Les taux AANP/IJM et la cotisation LPP ci-dessous sont des hypothèses contractuelles de recette, à remplacer par les attestations de caisse et d’assureur."),
    table([["Retenue salariale", "Mois", "Année"]]+[[label,chf(value),chf(value*12)] for label,value in monthly.items()]+[["Net payé",chf(cash_net),chf(cash_net*12)]], [309,95,95]),
    p("Formulaire officiel : montants attendus", "h2"),
    table([["Rubrique", "CHF"], ["Chiffres 1 et 8 : salaire brut",chf(annual_gross)], ["Chiffre 9 : AVS/AI/APG/AC/AANP",chf(certificate_9)], ["Chiffre 10.1 : prévoyance professionnelle",chf(certificate_10)], ["Chiffre 11 : salaire net fiscal",chf(certificate_net)], ["IJM exclue des déductions du chiffre 9", "360.00"]], [365,134]),
    p("<b>Écart volontaire à vérifier :</b> le net fiscal de 63'672.00 diffère du net bancaire de 63'312.00 de 360.00, car les primes IJM salariales ne sont pas déductibles sous le chiffre 9. Références : guide AFC 2026, chiffre marginal 42, et FAQ 9.1 [5,6]."),
    p("Les taux AVS/AI/APG de 5,3 % pour le salarié et AC de 1,1 % sous le plafond applicable sont vérifiés dans les mémentos [3,4]. Contrôler séparément la part patronale, les frais de caisse, les plafonds, les petits salaires, la retraite, les départs en cours d’année et les corrections. Un certificat PDF ne constitue pas une transmission ELM ni une certification Swissdec.", "small"), PageBreak()]

story += [p("04 / Procès-verbal de validation", "title"),
    p("Pour chaque cas, conserver la version exacte de Zentra, le profil de configuration, les pièces produites et les écarts constatés. Une coche technique dans l’application ne vaut pas validation professionnelle."),
    table([["Point", "Conclusion de la fiduciaire"], ["Cas 01 : comptabilité, TVA et bilan", "À exécuter / écarts à documenter"], ["Cas 02 : acompte et rapprochement bancaire", "À exécuter / écarts à documenter"], ["Cas 03 : paie et certificat annuel", "À exécuter / écarts à documenter"], ["Restauration et conservation des preuves", "À exécuter sur une installation distincte"], ["Modes TVA et situations salariales hors cas standard", "Périmètre accepté et limites à préciser"]], [285,214]),
    p("Cabinet / responsable : ___________________________________________<br/>Version examinée / date : _________________________________________<br/>Réserves et conditions : __________________________________________<br/>Décision / signature : ____________________________________________", "small"),
    p("Sources officielles consultées le 8 septembre 2026", "h2"),
]
sources = [
    ("1", "AFC - taux de TVA en vigueur", "https://www.estv.admin.ch/fr/taux-de-la-tva-suisse"),
    ("2", "AFC - taxe sur la valeur ajoutée", "https://www.estv.admin.ch/fr/taxe-sur-la-valeur-ajoutee"),
    ("3", "AVS/AI - mémento 2.01, état au 1er janvier 2026", "https://www.ahv-iv.ch/p/2.01.f"),
    ("4", "AVS/AI - mémento 2.08, réimpression novembre 2025", "https://www.ahv-iv.ch/p/2.08.f"),
    ("5", "AFC / CSI - guide du certificat de salaire 2026, CM 42", "https://www.estv.admin.ch/dam/fr/sd-web/afP1GDFr8gE3/dbst-form-lohna-wegleitung-2026-fr.pdf"),
    ("6", "AFC / CSI - FAQ 2026 du certificat de salaire, 9.1", "https://www.estv.admin.ch/dam/fr/sd-web/36S9l-hXKaLr/dbst-form-lohna-faq-2026-fr.pdf"),
    ("7", "SECO - obligations du commerce électronique", "https://www.seco.admin.ch/fr/commerce-electronique"),
]
for number,title,url in sources:
    story.append(p(f'[{number}] <link href="{url}" color="#173d2c"><u>{escape(title)}</u></link>', "small"))
story.append(p("L’identité, l’adresse de contact et une adresse électronique valide doivent être accessibles pour la vente en ligne [7]. L’adresse professionnelle du vendeur doit donc encore être complétée avant l’ouverture commerciale.", "small"))

def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor("#d9dfd4")); canvas.line(48,45,A4[0]-48,45)
    canvas.setFont("Review",8); canvas.setFillColor(MUTED)
    canvas.drawString(48,30,"ZENTRA  /  RECETTE FICTIVE - VALIDATION PROFESSIONNELLE À OBTENIR")
    canvas.drawRightString(A4[0]-48,30,str(doc.page))
    canvas.restoreState()

pdf = OUT / "Zentra-dossier-recette-fiduciaire.pdf"
SimpleDocTemplate(str(pdf),pagesize=A4,rightMargin=48,leftMargin=48,topMargin=48,bottomMargin=62,title="Zentra - Dossier de recette fiduciaire",author="Zentra").build(story,onFirstPage=footer,onLaterPages=footer)
print(pdf)
print("Expected-case arithmetic verified; professional execution remains pending.")
