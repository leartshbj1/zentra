"""Build the small, offline font set shared by the editor and the PDF renderer.

Requires fonttools==4.65.0. Input revisions are pinned; original licenses remain
beside the derived fonts and in their name tables. No font is fetched by the app.
"""
from pathlib import Path
from io import BytesIO
import hashlib
import json
import math
import urllib.parse
import urllib.request
import fontTools
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

assert fontTools.__version__ == '4.65.0', 'Use fonttools==4.65.0 for reproducible assets'
desktop = Path(__file__).resolve().parents[1]
assets = desktop / 'assets/document-fonts'
cache = desktop.parent / '.qa/document-font-originals'
assets.mkdir(parents=True, exist_ok=True)
cache.mkdir(parents=True, exist_ok=True)
families = [
    ('inter', 'Inter', '0b58fb370093f9a9f4ff785d94405710b79de67c'),
    ('literata', 'Literata', '4e5f06dbb274a27ebe71ed54ea706b3ee40eabd9'),
]
characters = {}
for byte in range(32, 256):
    try:
        character = bytes([byte]).decode('cp1252')
        if character.isprintable() or byte in (0xa0, 0xad):
            characters[byte] = ord(character)
    except UnicodeDecodeError:
        pass
sources, fonts = [], []
manifest_path = assets / 'manifest.json'
expected_sources = {item['url']: item['sha256'] for item in json.loads(manifest_path.read_text(encoding='utf-8'))['sources']} if manifest_path.exists() else {}

def source(family, revision, filename):
    url = f'https://raw.githubusercontent.com/google/fonts/{revision}/ofl/{family}/{urllib.parse.quote(filename)}'
    path = cache / f'{revision}-{filename}'
    if not path.exists():
        with urllib.request.urlopen(url, timeout=45) as response:
            data = response.read(4_000_001)
        assert len(data) <= 4_000_000, 'Unexpected source size'
        path.write_bytes(data)
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if expected_sources:
        assert expected_sources.get(url) == digest, f'Input differs from the reviewed source manifest: {filename}'
    sources.append({'url': url, 'sha256': digest, 'bytes': len(data)})
    return data

for family, label, revision in families:
    license_bytes = source(family, revision, 'OFL.txt')
    assert 'Reserved Font Name "' not in license_bytes.decode('utf-8'), 'Review reserved names before creating a derivative'
    (assets / f'{family}-OFL.txt').write_bytes(license_bytes)
    originals = {italic: source(family, revision, f'{label}{"-Italic" if italic else ""}[opsz,wght].ttf') for italic in (False, True)}
    for suffix, weight, italic in [('regular', 400, False), ('bold', 700, False), ('italic', 400, True), ('bold-italic', 700, True)]:
        font = TTFont(BytesIO(originals[italic]), recalcTimestamp=False)
        assert font['OS/2'].fsType == 0, 'The font must allow embedding and subsetting'
        font = instantiateVariableFont(font, {'wght': weight, 'opsz': 14}, inplace=True)
        # PDF WinAnsi uses the hyphen glyph at 0xAD, even when the source font
        # intentionally omits the Unicode discretionary-hyphen character.
        if 0xad not in font.getBestCmap():
            hyphen = font.getBestCmap()[0x2d]
            for table in font['cmap'].tables:
                if table.isUnicode():
                    table.cmap[0xad] = hyphen
        options = subset.Options()
        options.name_IDs = ['*']
        options.name_legacy = True
        options.name_languages = ['*']
        options.glyph_names = True
        options.layout_features = []
        options.hinting = True
        subsetter = subset.Subsetter(options=options)
        subsetter.populate(unicodes=characters.values())
        subsetter.subset(font)
        style = {'regular': 'Regular', 'bold': 'Bold', 'italic': 'Italic', 'bold-italic': 'Bold Italic'}[suffix]
        postscript = f'{label}-{style.replace(" ", "")}'
        names = font['name']
        names.names = [record for record in names.names if record.nameID not in (1, 2, 3, 4, 6, 13, 16, 17)]
        for name_id, value in {1: label, 2: style, 3: f'Zentra document subset {postscript}', 4: f'{label} {style}', 6: postscript, 16: label, 17: style}.items():
            names.setName(value, name_id, 3, 1, 0x409)
        # The complete notice accompanies every copy, including the font bytes
        # embedded into the application. It remains readable in font metadata.
        names.setName(license_bytes.decode('utf-8'), 13, 3, 1, 0x409)
        font.recalcTimestamp = False
        target = assets / f'{family}-{suffix}.ttf'
        font.save(target, reorderTables=True)
        checked = TTFont(target, recalcTimestamp=False)
        cmap = checked.getBestCmap()
        assert set(characters.values()).issubset(cmap), f'Missing printable characters in {target.name}'
        assert 'fvar' not in checked, 'Only static font instances are supported'
        units = checked['head'].unitsPerEm
        scaled = lambda value: round(value * 1000 / units)
        widths = [scaled(checked['hmtx'][cmap[characters[b]]][0]) if b in characters else 0 for b in range(256)]
        head, os2, post = checked['head'], checked['OS/2'], checked['post']
        data = target.read_bytes()
        fonts.append({'file': target.name, 'family': family, 'postscript': postscript,
                      'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'widths': widths,
                      'bbox': [math.floor(head.xMin * 1000 / units), math.floor(head.yMin * 1000 / units), math.ceil(head.xMax * 1000 / units), math.ceil(head.yMax * 1000 / units)],
                      'ascent': scaled(os2.sTypoAscender), 'descent': scaled(os2.sTypoDescender),
                      'capHeight': scaled(os2.sCapHeight), 'italicAngle': post.italicAngle,
                      'flags': 32 + (64 if italic else 0) + (2 if family == 'literata' else 0), 'stemV': 120 if weight == 700 else 80})

manifest = {'fonttools': fontTools.__version__, 'coverage': 'Windows-1252 printable characters; optical size 14; static weights 400 and 700', 'sources': sources, 'fonts': fonts}
(assets / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
lines = ['// Generated by desktop/scripts/build-document-fonts.py; keep licenses beside the assets.', 'use super::EmbeddedFont;', 'pub(super) const FONTS: [EmbeddedFont; 8] = [']
for font in fonts:
    lines += ['    EmbeddedFont {', f'        name: "ZENTRA+{font["postscript"]}",', f'        bytes: include_bytes!("../../assets/document-fonts/{font["file"]}"),', f'        bbox: {font["bbox"]},', f'        ascent: {font["ascent"]}, descent: {font["descent"]}, cap_height: {font["capHeight"]},', f'        italic_angle: {float(font["italicAngle"]):.1f}, flags: {font["flags"]}, stem_v: {font["stemV"]},', f'        widths: {font["widths"]},', '    },']
lines += ['];', '']
(desktop / 'src-tauri/src/document_embedded_font_data.rs').write_text('\n'.join(lines), encoding='utf-8')
print(json.dumps({'families': [f[1] for f in families], 'fonts': len(fonts), 'totalBytes': sum(f['bytes'] for f in fonts), 'files': [{'name': f['file'], 'bytes': f['bytes']} for f in fonts]}))
