"""Reject debug/unsafe APK candidates before a separate signing and device recipe."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess
import zipfile


def check_manifest(badging, tree, version):
    package = re.search(r"^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging, re.M)
    if not package or package[1] != 'ch.zentra.mobile' or package[3] != version:
        raise ValueError('Unexpected Android package or version')
    if int(package[2]) <= 0:
        raise ValueError('Missing Android version code')
    if 'application-debuggable' in badging.splitlines():
        raise ValueError('Debug APK cannot be a release candidate')
    # The manifest is compiled XML, so inspect aapt's typed boolean values.
    attrs = dict(re.findall(r'A: android:(\w+)\([^)]*\)=\(type 0x12\)(0x[0-9a-f]+)', tree, re.I))
    for key in ('debuggable', 'testOnly', 'usesCleartextTraffic'):
        if key in attrs and int(attrs[key], 16) != 0:
            raise ValueError(f'Unsafe release manifest attribute: {key}')
    if attrs.get('allowBackup') != '0x0':
        raise ValueError('Device-encrypted references must not be backed up by Android')
    abi = re.search(r'^native-code: (.+)$', badging, re.M)
    if not abi or re.findall(r"'([^']+)'", abi[1]) != ['arm64-v8a']:
        raise ValueError('Expected one arm64-v8a architecture')
    sdk = re.search(r"^sdkVersion:'(\d+)'", badging, re.M)
    target = re.search(r"^targetSdkVersion:'(\d+)'", badging, re.M)
    if not sdk or int(sdk[1]) != 24 or not target or int(target[1]) < 35:
        raise ValueError('Unexpected Android SDK compatibility')
    return {'package': package[1], 'version': package[3], 'versionCode': int(package[2]),
            'minimumSdk': int(sdk[1]), 'targetSdk': int(target[1]), 'debuggable': False,
            'testOnly': False, 'backupAllowed': False}


def check_elf(data, name):
    if len(data) < 64 or data[:6] != b'\x7fELF\x02\x01':
        raise ValueError(f'Expected ELF64 little-endian library: {name}')
    if struct.unpack_from('<H', data, 18)[0] != 183:
        raise ValueError(f'Expected AArch64 library: {name}')
    offset = struct.unpack_from('<Q', data, 32)[0]
    size, count = struct.unpack_from('<HH', data, 54)
    if size < 56 or offset + count * size > len(data):
        raise ValueError(f'Invalid ELF program headers: {name}')
    loads = 0
    for i in range(count):
        ptype, _, file_offset, virtual, _, _, memory_size, alignment = struct.unpack_from('<IIQQQQQQ', data, offset + i * size)
        if ptype == 1:
            loads += 1
            if alignment < 16384 or alignment & (alignment - 1) or (file_offset - virtual) % 16384:
                raise ValueError(f'Library does not support 16K pages: {name}')
        if ptype == 0x6474e552 and (virtual + memory_size) % 16384:
            raise ValueError(f'Library RELRO does not end on a 16K page: {name}')
    if not loads:
        raise ValueError(f'No ELF load segments: {name}')
    return loads


def check_archive(apk):
    with zipfile.ZipFile(apk) as archive:
        if archive.testzip() is not None:
            raise ValueError('Corrupt APK archive')
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError('Duplicate APK entries')
        libraries = [name for name in names if name.startswith('lib/') and name.endswith('.so')]
        if not libraries or any(not name.startswith('lib/arm64-v8a/') for name in libraries):
            raise ValueError('Missing or unexpected native libraries')
        return [{'path': name, 'loadSegments': check_elf(archive.read(name), name)} for name in libraries]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('apk', type=Path)
    parser.add_argument('--aapt', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{40}', args.source):
        raise ValueError('A complete source revision is required')
    badging = subprocess.check_output([args.aapt, 'dump', 'badging', str(args.apk)], text=True)
    tree = subprocess.check_output([args.aapt, 'dump', 'xmltree', str(args.apk), 'AndroidManifest.xml'], text=True)
    report = check_manifest(badging, tree, args.version)
    report.update({'source': args.source, 'sha256': hashlib.sha256(args.apk.read_bytes()).hexdigest(),
                   'bytes': args.apk.stat().st_size, 'nativeLibraries': check_archive(args.apk),
                   'signatureVerified': False, 'physicalDeviceTested': False,
                   'emulatorTested': False, 'published': False})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
