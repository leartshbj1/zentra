"""Install the approved iOS artwork after Tauri init and inspect compiled icons."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import struct
import zipfile
import zlib

ICON_ROOT = Path(__file__).resolve().parents[1] / 'src-tauri/icons/ios'
CATALOG = Path(__file__).resolve().parents[1] / 'src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset'


def pixels(data):
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('Expected a PNG icon')
    offset, compressed, optimized, header = 8, b'', False, None
    while offset < len(data):
        length = struct.unpack_from('>I', data, offset)[0]
        kind, body = data[offset + 4:offset + 8], data[offset + 8:offset + 8 + length]
        if len(body) != length or zlib.crc32(kind + body) != struct.unpack_from('>I', data, offset + 8 + length)[0]:
            raise ValueError('Corrupt icon PNG chunk')
        if kind == b'CgBI': optimized = True
        if kind == b'IHDR': header = struct.unpack('>IIBBBBB', body)
        if kind == b'IDAT': compressed += body
        offset += length + 12
    if not header:
        raise ValueError('Missing PNG dimensions')
    width, height, bits, color, compression, filtering, interlace = header
    if not (0 < width <= 2048 and 0 < height <= 2048 and bits == 8 and color in (2, 6) and compression == filtering == interlace == 0):
        raise ValueError('Unsupported icon PNG format')
    channels = 4 if color == 6 else 3
    stride = width * channels
    decoder = zlib.decompressobj(-15 if optimized else 15)
    raw = decoder.decompress(compressed, height * (stride + 1) + 1)
    if len(raw) != height * (stride + 1) or not decoder.eof:
        raise ValueError('Invalid PNG data size')
    previous, result = bytearray(stride), bytearray()
    for y in range(height):
        mode = raw[y * (stride + 1)]
        if mode > 4: raise ValueError('Invalid PNG filter')
        row = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for x in range(stride):
            a = row[x - channels] if x >= channels else 0
            b = previous[x]
            c = previous[x - channels] if x >= channels else 0
            p = a + b - c
            distances = (abs(p-a), abs(p-b), abs(p-c))
            paeth = (a, b, c)[distances.index(min(distances))]
            row[x] = (row[x] + (0, a, b, (a+b)//2, paeth)[mode]) & 255
        for x in range(0, stride, channels):
            rgb = row[x:x+3]
            alpha = row[x+3] if channels == 4 else 255
            if alpha != 255: raise ValueError('App icons must be opaque')
            result.extend(rgb[::-1] if optimized else rgb)
        previous = row
    return width, height, bytes(result)


def prepare(catalog=CATALOG, source=ICON_ROOT):
    manifest = json.loads((catalog / 'Contents.json').read_text())
    records = []
    for image in manifest['images']:
        name = image.get('filename')
        if not name:
            raise ValueError('An iOS icon slot has no artwork')
        if Path(name).name != name or '/' in name or '\\' in name:
            raise ValueError('Invalid icon filename')
        data = (source / name).read_bytes()
        width, height, _ = pixels(data)
        size = image['size'].split('x'); scale = float(image['scale'].removesuffix('x'))
        if (width, height) != (float(size[0])*scale, float(size[1])*scale):
            raise ValueError('Wrong dimensions for ' + name)
        records.append((name, data))
    if not records or len({name for name, _ in records}) != len(records):
        raise ValueError('Empty or duplicate iOS icon slots')
    for name, data in records:
        target = catalog / name
        if target.is_symlink(): raise ValueError('Refusing an icon symlink')
        target.write_bytes(data)
    return {'icons': [{'file': name, 'sha256': hashlib.sha256(data).hexdigest()} for name, data in records]}


def verify_ipa_icons(ipa, source=ICON_ROOT):
    checks = []
    with zipfile.ZipFile(ipa) as archive:
        roots = [n.removesuffix('Info.plist') for n in archive.namelist() if n.startswith('Payload/') and n.count('/') == 2 and n.endswith('.app/Info.plist')]
        if len(roots) != 1: raise ValueError('Expected one iOS application')
        base = roots[0]
        info = plistlib.loads(archive.read(base + 'Info.plist'))
        if info.get('CFBundleIcons', {}).get('CFBundlePrimaryIcon', {}).get('CFBundleIconName') != 'AppIcon':
            raise ValueError('AppIcon is not the primary iPhone icon')
        if not archive.read(base + 'Assets.car'): raise ValueError('Missing compiled icon catalog')
        for compiled, name in [('AppIcon60x60@2x.png', 'AppIcon-60x60@2x.png'), ('AppIcon76x76@2x~ipad.png', 'AppIcon-76x76@2x.png')]:
            data = archive.read(base + compiled)
            if pixels(data) != pixels((source / name).read_bytes()):
                raise ValueError('Compiled iOS icon differs from Zentra artwork: ' + compiled)
            checks.append({'file': compiled, 'source': name, 'pixelsIdentical': True, 'sha256': hashlib.sha256(data).hexdigest()})
    return checks


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['prepare', 'verify'])
    parser.add_argument('--ipa', type=Path)
    args = parser.parse_args()
    if args.operation == 'verify' and not args.ipa: parser.error('--ipa is required')
    print(json.dumps(prepare() if args.operation == 'prepare' else verify_ipa_icons(args.ipa), indent=2))
