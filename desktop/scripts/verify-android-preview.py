"""Verify a signed, optimized preview without asserting installation or publication.

The unsigned input must match an independently recorded build hash. Signing may
add signature entries, but must not change any application resource or library.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import zipfile

spec = importlib.util.spec_from_file_location('release_check', Path(__file__).with_name('check-android-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
SIGNATURE_ENTRY = re.compile(r'META-INF/(MANIFEST\.MF|[^/]+\.(SF|RSA|DSA|EC))', re.I)


def payload(apk):
    with zipfile.ZipFile(apk) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or archive.testzip() is not None:
            raise ValueError('Corrupt or duplicate APK entries')
        return {name: hashlib.sha256(archive.read(name)).hexdigest()
                for name in names if not SIGNATURE_ENTRY.fullmatch(name)}


def compare_payload(unsigned, signed):
    original, candidate = payload(unsigned), payload(signed)
    if original != candidate:
        changed = sorted(name for name in original.keys() | candidate.keys()
                         if original.get(name) != candidate.get(name))
        raise ValueError(f'Signing changed the application payload: {changed[:5]}')
    return len(original)


def check_signature_output(output, pin):
    if not re.fullmatch(r'[0-9a-f]{64}', pin):
        raise ValueError('Invalid pinned signing identity')
    if not re.search(r'^Verified using v2 scheme .*: true$', output, re.M):
        raise ValueError('APK v2 signature is required for the minimum Android version')
    signers = re.findall(r'^Signer #\d+ certificate SHA-256 digest: ([0-9a-f]+)$', output, re.M)
    if signers != [pin] or not re.search(r'^Number of signers: 1$', output, re.M):
        raise ValueError('Android preview certificate differs from the pinned identity')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--unsigned', type=Path, required=True)
    parser.add_argument('--signed', type=Path, required=True)
    parser.add_argument('--expected-sha256', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--java', type=Path, required=True)
    parser.add_argument('--build-tools', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError('Refusing to replace an existing verification receipt')
    if (not re.fullmatch(r'[0-9a-f]{40}', args.source)
            or not re.fullmatch(r'[0-9a-f]{64}', args.expected_sha256)
            or hashlib.sha256(args.unsigned.read_bytes()).hexdigest() != args.expected_sha256):
        raise ValueError('Source revision or independently recorded build hash does not match')
    suffix = '.exe' if (args.build_tools / 'aapt.exe').exists() else ''
    aapt = args.build_tools / ('aapt' + suffix)
    zipalign = args.build_tools / ('zipalign' + suffix)
    signed_report = None
    for apk in (args.unsigned, args.signed):
        badging = subprocess.check_output([str(aapt), 'dump', 'badging', str(apk)], text=True)
        tree = subprocess.check_output([str(aapt), 'dump', 'xmltree', str(apk), 'AndroidManifest.xml'], text=True)
        signed_report = release.check_manifest(badging, tree, args.version)
        signed_report['nativeLibraries'] = release.check_archive(apk)
        subprocess.run([str(zipalign), '-c', '-P', '16', '4', str(apk)], check=True, capture_output=True)
    verification = subprocess.check_output([
        str(args.java), '-jar', str(args.build_tools / 'lib/apksigner.jar'),
        'verify', '--verbose', '--print-certs', str(args.signed)], text=True)
    pin = (Path(__file__).parents[1] / 'android-preview-certificate.sha256').read_text().strip().lower()
    check_signature_output(verification, pin)
    entries = compare_payload(args.unsigned, args.signed)
    signed_report.update({
        'source': args.source, 'unsignedSha256': args.expected_sha256,
        'sha256': hashlib.sha256(args.signed.read_bytes()).hexdigest(),
        'bytes': args.signed.stat().st_size, 'certificateSha256': pin,
        'signatureVerified': True, 'signingIdentity': 'persistent-preview',
        'alignment16K': True, 'unchangedPayloadEntries': entries,
        'physicalDeviceTested': False, 'emulatorTested': False, 'published': False,
    })
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation prevents a stale receipt from being silently replaced.
    with args.output.open('x', encoding='utf-8') as destination:
        destination.write(json.dumps(signed_report, indent=2) + '\n')
    print(json.dumps(signed_report))


if __name__ == '__main__':
    main()
