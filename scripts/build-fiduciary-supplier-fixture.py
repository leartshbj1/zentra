"""Synthetic INPUT documents for the independent fiduciary acceptance case.

These supplier documents are authored fixtures, not exports made by Zentra.
The native acceptance imports their original bytes through the attachment API.
"""
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen.canvas import Canvas

root = Path(__file__).resolve().parent.parent
destination = root / "docs/recette-fiduciaire/fixtures/pieces-fournisseur-fictives.pdf"
destination.parent.mkdir(parents=True, exist_ok=True)
canvas = Canvas(str(destination), pagesize=A4, invariant=1)
canvas.setTitle("Pièces fournisseur fictives - recette indépendante Zentra")
canvas.setAuthor("Dossier de recette - données entièrement fictives")
for index, (title, reference, date, description, net, vat, total) in enumerate([
    ("Facture fournisseur", "RECETTE-ACHAT", "12.01.2026", "Marchandises intégralement consommées", "400.00", "32.40", "432.40"),
    ("Avoir fournisseur", "RECETTE-AVOIR-ACHAT", "22.01.2026", "Réduction sur la facture RECETTE-ACHAT", "50.00", "4.05", "54.05"),
], 1):
    canvas.setFillColor(colors.HexColor("#174d35"))
    canvas.rect(0, 788, A4[0], 54, fill=1, stroke=0)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 14)
    canvas.drawString(42, 807, "RECETTE FICTIVE - AUCUN PAIEMENT À EFFECTUER")
    canvas.setFillColor(colors.HexColor("#17251d"))
    canvas.setFont("Helvetica-Bold", 23)
    canvas.drawString(42, 735, title)
    canvas.setFont("Helvetica", 12)
    for y, value in [(701, reference), (680, f"Date : {date}"),
                     (630, "Fournisseur fictif - marchandises"),
                     (609, "Adresse fictive 1, 1000 Lausanne"),
                     (588, "IDE de démonstration : CHE-987.654.321 TVA"),
                     (535, "Destinataire : Recette fiduciaire fictive Sàrl"),
                     (514, "Adresse de test 17B, 1000 Ville test"),
                     (450, description)]:
        canvas.drawString(42, y, value)
    for y, label, value in [(385, "Montant net CHF", net), (352, "TVA 8,1 % CHF", vat),
                             (312, "Total TTC CHF" if index == 1 else "Montant à rembourser CHF", total)]:
        canvas.setFont("Helvetica-Bold" if y == 312 else "Helvetica", 13)
        canvas.drawString(42, y, label)
        canvas.drawRightString(550, y, value)
    canvas.setFont("Helvetica", 10)
    canvas.setFillColor(colors.HexColor("#52665a"))
    for y, line in [(125, "Document d'entrée synthétique créé pour vérifier le logiciel."),
                    (108, "Il ne prouve aucun achat réel, aucun assujettissement et aucune déduction fiscale."),
                    (91, "Les noms, adresses, IDE et transactions sont entièrement fictifs.")]:
        canvas.drawString(42, y, line)
    canvas.drawRightString(550, 45, f"{index} / 2")
    canvas.showPage()
canvas.save()
print(destination)
