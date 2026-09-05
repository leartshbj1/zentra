"""Validate a synthetic native VAT export against the official eCH 2.0.0 XSD.

Usage: python desktop/tests/validate-vat-xml.py XML_PATH CACHE_DIRECTORY
Requires lxml. Downloads only public eCH schemas and records their hashes.
"""
import hashlib
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from lxml import etree

ROOT = 'https://www.ech.ch/sites/default/files/imce/eCH-Dossier/0211-0240/eCH-0217/2.0.0/Beilagen/eCH-0217-2-0-0.xsd'
xml_path, cache = Path(sys.argv[1]), Path(sys.argv[2])
cache.mkdir(parents=True, exist_ok=True)
manifest = {}
parser = etree.XMLParser(resolve_entities=False, no_network=True)

def schema(url):
    url = url.replace('http://', 'https://', 1)
    if urllib.parse.urlparse(url).hostname not in ('www.ech.ch', 'ech.ch'):
        raise ValueError(f'Unexpected schema host: {url}')
    name = hashlib.sha256(url.encode()).hexdigest() + '.xsd'
    if url in manifest:
        return name
    if len(manifest) > 30:
        raise ValueError('Too many schema dependencies')
    with urllib.request.urlopen(url, timeout=30) as response:
        data = response.read(2_000_001)
    if len(data) > 2_000_000:
        raise ValueError('Schema exceeds the download limit')
    manifest[url] = {'file': name, 'sha256': hashlib.sha256(data).hexdigest()}
    tree = etree.fromstring(data, parser)
    for item in tree.xpath('//*[@schemaLocation]'):
        dependency = urllib.parse.urljoin(url, item.get('schemaLocation'))
        item.set('schemaLocation', schema(dependency))
    (cache / name).write_bytes(etree.tostring(tree, xml_declaration=True, encoding='UTF-8'))
    return name

root = schema(ROOT)
validator = etree.XMLSchema(etree.parse(str(cache / root), parser))
validator.assertValid(etree.parse(str(xml_path), parser))
proof = {'valid': True, 'xml': str(xml_path), 'xmlSha256': hashlib.sha256(xml_path.read_bytes()).hexdigest(), 'schemas': manifest}
(cache / 'validation.json').write_text(json.dumps(proof, indent=2), encoding='utf-8')
print(json.dumps({'valid': True, 'schemas': len(manifest), 'xmlSha256': proof['xmlSha256']}))
