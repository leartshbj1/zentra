"""Exercise an optimized ARM payload on an owned, disposable Android emulator.

No production account, signing key, company or customer data is used. A throwaway
certificate permits installation of the exact unsigned CI payload for this test
only; it is not a replacement for the persistent local preview signature.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[1] / 'desktop/artifacts/android-release-smoke'
OUT.mkdir(parents=True, exist_ok=True)
JOB = 157
REVISION = 'a490d797e2358dc95fc1615e48ea82eb400f86b1'
SHA = 'aff706d3c1d42c0222cbee2a365e14ba5bfc65c0b685d7a294491df2b760168d'
PACKAGE = 'ch.zentra.mobile'
PROFILE = '/data/user/0/' + PACKAGE


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def run(*args, binary=False, timeout=45):
    return subprocess.check_output(args, text=not binary, timeout=timeout).strip()


def adb(*args, **kwargs):
    return run('adb', '-s', 'emulator-5554', *args, **kwargs)


def snapshot(label):
    remote = '/sdcard/zentra-owned-smoke.xml'
    adb('shell', 'uiautomator', 'dump', '--compressed', remote, timeout=30)
    data = adb('exec-out', 'cat', remote)
    (OUT / (label + '.xml')).write_text(data, encoding='utf-8')
    # Do not strip PNG bytes: trailing whitespace can be part of the checksum.
    png = subprocess.check_output(['adb', '-s', 'emulator-5554', 'exec-out', 'screencap', '-p'], timeout=30)
    (OUT / (label + '.png')).write_bytes(png)
    return ET.fromstring(data)


def visible(root):
    return [(n.get('text', '') or n.get('content-desc', '')).strip() for n in root.iter('node')]


def tap(root, labels):
    for node in root.iter('node'):
        if (node.get('text') or node.get('content-desc')) in labels:
            coords = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
            if coords and node.get('enabled') == 'true':
                x1, y1, x2, y2 = map(int, coords.groups())
                adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2))
                return True
    return False


def wait_ui(label, predicate, seconds=100):
    deadline = time.monotonic() + seconds
    last_error = None
    while time.monotonic() < deadline:
        adb('shell', 'pidof', PACKAGE)
        try:
            root = snapshot(label)
            if predicate(visible(root)):
                return root
        except (subprocess.SubprocessError, ET.ParseError) as error:
            last_error = type(error).__name__
        time.sleep(2)
    raise RuntimeError(f'Expected usable screen missing: {label}; last capture error={last_error}')


def profile_state(temp, label):
    # Caller has force-stopped this emulator-only installation. Copy the SQLite
    # file and WAL together without ever reading any real installation profile.
    files = adb('shell', 'find', PROFILE, '-type', 'f').splitlines()
    identity = [f for f in files if f.endswith('/installation-identity.protected')]
    databases = [f for f in files if f.endswith('/helvichantier.sqlite3')]
    if len(identity) != 1 or len(databases) != 1:
        raise RuntimeError('Native SQLite and protected installation identity were not initialized')
    identity_hash = adb('shell', 'sha256sum', identity[0]).split()[0]
    destination = temp / label
    destination.mkdir()
    for remote in files:
        if remote in [databases[0], databases[0] + '-wal', databases[0] + '-shm']:
            content = subprocess.check_output(['adb', '-s', 'emulator-5554', 'exec-out', 'cat', remote], timeout=30)
            (destination / Path(remote).name).write_bytes(content)
    with sqlite3.connect(destination / 'helvichantier.sqlite3') as db:
        integrity = db.execute('pragma integrity_check').fetchone()[0]
        schema = db.execute('pragma user_version').fetchone()[0]
        foreign_keys = db.execute('pragma foreign_key_check').fetchall()
    if integrity != 'ok' or foreign_keys or schema != 60:
        raise RuntimeError('Native profile failed integrity or schema checks')
    return {'identitySha256': identity_hash, 'schema': schema, 'integrity': integrity, 'foreignKeyErrors': 0}


def main():
    if adb('shell', 'getprop', 'ro.kernel.qemu') != '1':
        raise RuntimeError('Refusing to operate on a physical device')
    abi = adb('shell', 'getprop', 'ro.product.cpu.abilist')
    if 'arm64-v8a' not in abi.split(','):
        raise RuntimeError('This emulator does not expose ARM64 translation')
    adb('root')
    adb('wait-for-device')
    if adb('shell', 'id', '-u') != '0':
        raise RuntimeError('Disposable emulator root is required to inspect a non-debuggable profile')
    if PACKAGE in adb('shell', 'pm', 'list', 'packages'):
        raise RuntimeError('Expected a fresh emulator without Zentra')
    fetch = module('cloud_fetch', 'cloud-package-smoke.py').fetch
    verifier = module('preview_verify', 'verify-android-preview.py')
    release = module('candidate_check', 'check-android-release.py')
    api = f'https://circleci.com/api/v1.1/project/github/leartshbj1/zentra/{JOB}'
    job = json.loads(fetch(api))
    if job['status'] != 'success' or job['vcs_revision'] != REVISION:
        raise RuntimeError('Unexpected source build')
    records = {Path(a['path']).name: a for a in json.loads(fetch(api + '/artifacts'))}
    tools = Path(os.environ['ANDROID_HOME']) / 'build-tools/36.0.0'
    proof = {'source': REVISION, 'sourceJob': JOB, 'unsignedSha256': SHA, 'emulatorAbis': abi,
             'signingIdentity': 'disposable-emulator-only', 'physicalDeviceTested': False, 'published': False}
    with tempfile.TemporaryDirectory(prefix='zentra-android-payload-') as folder:
        temp = Path(folder)
        apk = temp / 'unsigned.apk'
        apk.write_bytes(fetch(records['Zentra-android-build-release.apk']['url']))
        if hashlib.sha256(apk.read_bytes()).hexdigest() != SHA:
            raise RuntimeError('Downloaded payload hash mismatch')
        badging = run(str(tools / 'aapt'), 'dump', 'badging', str(apk))
        tree = run(str(tools / 'aapt'), 'dump', 'xmltree', str(apk), 'AndroidManifest.xml')
        proof['manifest'] = release.check_manifest(badging, tree, '1.90.6')
        proof['nativeLibraries'] = release.check_archive(apk)
        signed, key = temp / 'test-only.apk', temp / 'ephemeral.p12'
        run('keytool', '-genkeypair', '-keystore', str(key), '-storetype', 'PKCS12', '-storepass', 'test-only-fixture',
            '-keypass', 'test-only-fixture', '-alias', 'fixture', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2',
            '-dname', 'CN=Disposable Zentra Emulator Fixture')
        run(str(tools / 'apksigner'), 'sign', '--ks', str(key), '--ks-pass', 'pass:test-only-fixture',
            '--v4-signing-enabled', 'false', '--out', str(signed), str(apk))
        run(str(tools / 'apksigner'), 'verify', '--verbose', str(signed))
        run(str(tools / 'zipalign'), '-c', '-P', '16', '4', str(signed))
        proof['unchangedPayloadEntries'] = verifier.compare_payload(apk, signed)
        proof['emulatorApkSha256'] = hashlib.sha256(signed.read_bytes()).hexdigest()
        adb('install', str(signed), timeout=120)
        # No account is used and no production endpoint is needed for this recipe.
        adb('shell', 'svc', 'wifi', 'disable')
        adb('shell', 'svc', 'data', 'disable')
        adb('logcat', '-c')
        started = time.monotonic()
        proof['launch'] = adb('shell', 'am', 'start', '-W', '-n', PACKAGE + '/.MainActivity')
        starts = {'Commencer', 'Start', 'Inizia', 'Beginnen'}
        welcome = wait_ui('01-welcome', lambda labels: bool(starts.intersection(labels)), seconds=150)
        proof['usableWelcomeMs'] = round((time.monotonic()-started)*1000)
        if not tap(welcome, starts):
            raise RuntimeError('Welcome start control is not usable')
        account_markers = {'Tout commence avec vous.', 'It all starts with you.', 'Alles beginnt mit Ihnen.', 'Tutto inizia da te.'}
        account = wait_ui('02-account', lambda labels: bool(account_markers.intersection(labels)))
        proof['accountScreenVisible'] = True
        # Normal app restart, with the native identity and database preserved.
        adb('shell', 'am', 'force-stop', PACKAGE)
        before = profile_state(temp, 'before-restart')
        proof['restart'] = adb('shell', 'am', 'start', '-W', '-n', PACKAGE + '/.MainActivity')
        wait_ui('03-restarted', lambda labels: bool(account_markers.intersection(labels) or starts.intersection(labels)))
        adb('shell', 'am', 'force-stop', PACKAGE)
        after = profile_state(temp, 'after-restart')
        if before != after:
            raise RuntimeError('Profile or protected identity changed after restart')
        crash = adb('logcat', '-b', 'crash', '-d')
        (OUT / 'crash.log').write_text(crash, encoding='utf-8')
        if PACKAGE in crash:
            raise RuntimeError('Application crash reported by Android')
        proof.update({'profileBefore': before, 'profileAfter': after, 'emulatorTested': True,
                      'onboardingAccountReached': True, 'restartPassed': True,
                      'accountConnected': False, 'companyCreated': False})
        (OUT / 'proof.json').write_text(json.dumps(proof, indent=2) + '\n')
        print(json.dumps(proof), flush=True)


if __name__ == '__main__':
    try:
        main()
    finally:
        try:
            (OUT / 'runtime.log').write_text(adb('logcat', '-d'), encoding='utf-8')
        except subprocess.SubprocessError:
            pass
