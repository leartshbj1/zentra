"""Inspect synthetic reports produced by the native Rust renderer, never customer files."""
import json
import pathlib
import sys
import pdfplumber
from pypdf import PdfReader

root = pathlib.Path(__file__).resolve().parents[1] / '.qa' / 'project-reports-clarity'
if '--prepare' in sys.argv:
    report = json.loads((root / 'internal.json').read_text(encoding='utf-8'))
    report['sections'].append({'title':'Contrôle de pagination — données fictives','headers':['Prestation','Date','Montant'],'rows':[[f'Ligne {i:03d} — Étude et réalisation avec suivi détaillé du projet.\nCoordination, contrôle et réception des prestations.','27.09.2026','CHF 1’080.00'] for i in range(120)]})
    (root / 'long.json').write_text(json.dumps(report,ensure_ascii=False),encoding='utf-8')
    print('Prepared synthetic long report')
    raise SystemExit(0)

results=[]
for name in ['summary','client','internal','long']:
    path=root/f'{name}.pdf'
    reader=PdfReader(path)
    text='\n'.join(page.extract_text() or '' for page in reader.pages)
    assert 'Rénovation Bellevue' in text, name
    assert 'Toute la durée du projet' in text, name
    assert 'aucun filtre de date' in text and 'Repères du rapport' in text, name
    assert 'Rubriques incluses' in text and 'Informations manquantes' in text, name
    assert 'Préparé par' in text, name
    if name=='client':
        assert 'SECRET-DRAFT' not in text and 'NOTE INTERNE CONFIDENTIELLE' not in text and 'Marge sur coûts enregistrés' not in text and 'Marge estimée' not in text
    else:
        assert 'Marge sur coûts enregistrés' in text and 'Marge estimée' in text
        assert 'coûts prévisionnels complets non disponibles' in text
    # A section label/header must not be stranded before its first body row.
    for page in reader.pages:
        page_text=page.extract_text() or ''
        if 'Détail F-REPORT-0' in page_text:
            assert 'Préparation des surfaces' in page_text,(name,'orphaned detail heading')
        if 'Factures et avoirs' in page_text:
            assert 'F-REPORT-0' in page_text,(name,'orphaned invoice heading')
    if name in ['internal','long']:
        assert 'NOTE INTERNE CONFIDENTIELLE' in text and 'SECRET-DRAFT' in text
    if name=='long':
        assert len(reader.pages)>4
        assert 'Ligne 000' in text and 'Ligne 119' in text
    outside=[]
    with pdfplumber.open(path) as pdf:
        for i,page in enumerate(pdf.pages):
            for word in page.extract_words():
                if word['x0']<0 or word['x1']>page.width+1 or word['top']<0 or word['bottom']>page.height+1:
                    outside.append({'page':i+1,'text':word['text']})
    assert not outside,(name,outside)
    results.append({'name':name,'pages':len(reader.pages),'outsidePage':outside,'passed':True})
(root/'pdf-proof.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
print(json.dumps(results))
