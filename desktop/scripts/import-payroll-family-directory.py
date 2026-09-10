"""Import factual CAF names/numbers from the OFAS 01.01.2026 register.

Usage: python import-payroll-family-directory.py downloaded.pdf directory.json
The source contains historic rows. Only a marked 2026 cell is eligible.
"""
import hashlib
import json
import re
import sys
from pathlib import Path
import pdfplumber

source, output = map(Path, sys.argv[1:])
funds = {}
seen = 0
with pdfplumber.open(source) as pdf:
    assert len(pdf.pages) == 84, 'Recheck the register layout before importing a new edition.'
    for page_index, page in enumerate(pdf.pages):
        for table in page.extract_tables():
            for row in table:
                if not row[0] or not re.fullmatch(r'\d{3}\.\d{3}', row[0]):
                    continue
                assert len(row) == 25, (page_index, len(row))
                seen += 1
                if 'X' not in (row[21] or '').upper():
                    continue
                number = row[0]
                name = re.sub(r'\s+', ' ', row[1] or '').strip()
                assert name and '\ufffd' not in name, (number, name)
                canton = (row[22] or '').strip()
                assert re.fullmatch(r'[A-Z]{2}', canton), (number, canton)
                if number not in funds:
                    funds[number] = {'id': f'family-{number}', 'number': number, 'name': name,
                        'kind': 'family', 'group': 'Allocations familiales · OFAS 2026', 'cantons': [],
                        'source': 'https://www.bsv.admin.ch/fr/allocations-familiales-organisation'}
                if funds[number]['name'] != name:
                    aliases = funds[number].setdefault('aliases', [])
                    if name not in aliases:
                        aliases.append(name)
                    if name.startswith('Caisse') and not funds[number]['name'].startswith('Caisse'):
                        aliases.append(funds[number]['name'])
                        aliases.remove(name)
                        funds[number]['name'] = name
                if canton not in funds[number]['cantons']:
                    funds[number]['cantons'].append(canton)
        if page_index % 14 == 0:
            print(f'Page {page_index + 1}/84, {len(funds)} caisses admises', flush=True)
data = json.loads(output.read_text(encoding='utf-8'))
data['entries'] = [entry for entry in data['entries'] if entry['kind'] != 'family'] + list(funds.values())
data['familyRegister'] = {'edition': '2026-01-01', 'sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'rowsReviewed': seen, 'activeFunds': len(funds), 'source': 'https://www.bsv.admin.ch/dam/fr/sd-web/OrD7uoqkgs1z/FamZG_FAK-Nummer_CH_2026.pdf'}
output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(data['familyRegister']))
