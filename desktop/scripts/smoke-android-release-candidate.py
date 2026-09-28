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
JOB = int(os.environ.get('ZENTRA_ANDROID_SMOKE_JOB', '160'))
REVISION = os.environ.get('ZENTRA_ANDROID_SMOKE_SOURCE', '68b1d2974feb887ad98d6cec795a836a8fbd790a')
SHA = os.environ.get('ZENTRA_ANDROID_SMOKE_SHA256', 'e108ced9f6c388d7674bf1705087ce0af8722d34f8c5e80162afb2da613cb411')
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


def capture_screen(label):
    # Do not strip PNG bytes: trailing whitespace can be part of the checksum.
    png = subprocess.check_output(['adb', '-s', 'emulator-5554', 'exec-out', 'screencap', '-p'], timeout=30)
    (OUT / (label + '.png')).write_bytes(png)


def snapshot(label):
    # uiautomator can exit successfully without producing a new dump. Never
    # accept the preceding launch's XML as evidence that the current UI opened.
    remote = f'/sdcard/zentra-owned-smoke-{time.monotonic_ns()}.xml'
    adb('shell', 'uiautomator', 'dump', '--compressed', remote, timeout=30)
    data = adb('exec-out', 'cat', remote)
    (OUT / (label + '.xml')).write_text(data, encoding='utf-8')
    capture_screen(label)
    return ET.fromstring(data)


def visible(root):
    return [(n.get('text', '') or n.get('content-desc', '')).strip() for n in root.iter('node')]


def bounds(node):
    coords = re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', node.get('bounds', ''))
    if coords:
        x1, y1, x2, y2 = map(int, coords.groups())
        if x2 > x1 and y2 > y1:
            return x1, y1, x2, y2
    return None


def tap(root, labels):
    matches = [n for n in root.iter('node') if (n.get('text') or n.get('content-desc')) in labels]
    # Android exposes both a control and its label. Prefer the actual control;
    # never tap [0,0][0,0] from an off-screen accessibility node.
    for node in sorted(matches, key=lambda n: n.get('clickable') != 'true'):
        box = bounds(node)
        if box and box[3]-box[1] >= 24 and node.get('enabled') == 'true':
            x1, y1, x2, y2 = box
            adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2))
            return True
    return False


def check_account_header(root):
    brand = [bounds(n) for n in root.iter('node') if n.get('class') == 'android.widget.Image' and n.get('text') == 'Zentra']
    controls = [bounds(n) for n in root.iter('node') if n.get('clickable') == 'true' and n.get('text') in {'Apparence', 'Langue de l’application'}]
    if len(brand) != 1 or len(controls) != 2 or not brand[0] or not all(controls):
        raise RuntimeError('Brand and both preference controls must be visible')
    a = brand[0]
    for b in controls:
        if a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]:
            raise RuntimeError('Account brand overlaps a preference control')
    return {'brand': a, 'preferences': controls, 'noOverlap': True}


def webview_bounds(root):
    boxes = [bounds(n) for n in root.iter('node') if n.get('class') == 'android.webkit.WebView' and bounds(n)]
    if not boxes:
        raise RuntimeError('Visible WebView bounds missing')
    return boxes[-1]


def check_keyboard_field(root, window_dump):
    # Use the OS's IME inset, not a fixed keyboard height or screenshot guess.
    ime_boxes = []
    for line in window_dump.splitlines():
        if not re.search(r'(?:mType|type)=ime\b', line) or not re.search(r'(?:mVisible|visible)=true\b', line):
            continue
        frame = re.search(r'(?:mFrame|frame)=(\[\d+,\d+\]\[\d+,\d+\])', line)
        if frame:
            box = bounds(ET.Element('node', bounds=frame[1]))
            if box:
                ime_boxes.append(box)
    if not ime_boxes:
        raise RuntimeError('Visible keyboard inset missing')
    keyboard_top = min(box[1] for box in ime_boxes)
    focused = [n for n in root.iter('node') if n.get('class') == 'android.widget.EditText' and n.get('focused') == 'true']
    box = bounds(focused[0]) if len(focused) == 1 else None
    viewport = webview_bounds(root)
    if not box or box[3]-box[1] < 40 or box[1] < viewport[1] or box[3] > keyboard_top or viewport[3] > keyboard_top:
        raise RuntimeError('Focused field or WebView is obscured by the keyboard')
    return {'focusedField': box, 'webView': viewport, 'keyboardTop': keyboard_top}


def wait_keyboard_field(label):
    deadline = time.monotonic() + 45
    last_error = None
    while time.monotonic() < deadline:
        try:
            root = snapshot(label)
            windows = adb('shell', 'dumpsys', 'window')
            (OUT / (label + '-windows.txt')).write_text(windows, encoding='utf-8')
            return root, check_keyboard_field(root, windows)
        except (RuntimeError, subprocess.SubprocessError, ET.ParseError) as error:
            last_error = str(error)
        time.sleep(1)
    raise RuntimeError(f'Keyboard field never became usable: {last_error}')


def scroll(root):
    frame = next((bounds(n) for n in root.iter('node') if bounds(n)), None)
    if not frame:
        raise RuntimeError('Cannot determine emulator viewport')
    x1, y1, x2, y2 = frame
    adb('shell', 'input', 'swipe', str((x1+x2)//2), str(y1+(y2-y1)*3//4),
        str((x1+x2)//2), str(y1+(y2-y1)//4), '350')


def scroll_and_tap(root, labels, label):
    for attempt in range(5):
        if tap(root, labels):
            return
        scroll(root)
        root = snapshot(f'{label}-{attempt+1}')
    raise RuntimeError(f'Control not reachable by scrolling: {labels}')


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
            capture_screen(label + '-while-inspecting')
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
    if JOB <= 0 or not re.fullmatch(r'[0-9a-f]{40}', REVISION) or not re.fullmatch(r'[0-9a-f]{64}', SHA):
        raise ValueError('An exact source job, revision and independently recorded hash are required')
    if adb('shell', 'getprop', 'ro.kernel.qemu') != '1':
        raise RuntimeError('Refusing to operate on a physical device')
    abi = adb('shell', 'getprop', 'ro.product.cpu.abilist')
    if 'arm64-v8a' not in abi.split(','):
        raise RuntimeError('This emulator does not expose ARM64 translation')
    print(f'Disposable emulator ready; supported ABIs: {abi}', flush=True)
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
    proof['displaySize'] = adb('shell', 'wm', 'size')
    proof['displayDensity'] = adb('shell', 'wm', 'density')
    (OUT / 'webview-provider.txt').write_text(adb('shell', 'dumpsys', 'webviewupdate'), encoding='utf-8')
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
        print('Verified optimized ARM payload installed on the disposable emulator', flush=True)
        # No account is used and no production endpoint is needed for this recipe.
        adb('shell', 'svc', 'wifi', 'disable')
        adb('shell', 'svc', 'data', 'disable')
        adb('logcat', '-c')
        started = time.monotonic()
        proof['launch'] = adb('shell', 'am', 'start', '-W', '-n', PACKAGE + '/.MainActivity')
        capture_screen('00-first-frame')
        starts = {'Commencer', 'Start', 'Inizia', 'Beginnen'}
        welcome = wait_ui('01-welcome', lambda labels: bool(starts.intersection(labels)), seconds=150)
        proof['accessibleWelcomeObservedMs'] = round((time.monotonic()-started)*1000)
        print(f'Usable welcome interface observed after {proof["accessibleWelcomeObservedMs"]} ms, including accessibility inspection', flush=True)
        if not tap(welcome, starts):
            raise RuntimeError('Welcome start control is not usable')
        account_markers = {'Tout commence avec vous.', 'It all starts with you.', 'Alles beginnt mit Ihnen.', 'Tutto inizia da te.'}
        account = wait_ui('02-account', lambda labels: bool(account_markers.intersection(labels)))
        proof['accountScreenVisible'] = True
        proof['accountHeader'] = check_account_header(account)
        print('Account setup screen reached without connecting an account', flush=True)
        # Exercise the real Android select popup and record both native themes.
        # Screenshots are reviewed separately; choosing an option alone does not
        # prove that the native bars have the correct contrast.
        for mode in ('Sombre', 'Clair'):
            if not tap(account, {'Apparence'}):
                raise RuntimeError('Appearance selector is not reachable')
            choices = wait_ui('appearance-options', lambda labels: mode in labels)
            if not tap(choices, {mode}):
                raise RuntimeError('Native appearance option is not reachable')
            account = wait_ui('02-account-' + mode, lambda labels: bool(account_markers.intersection(labels)))
            (OUT / ('window-' + mode + '.txt')).write_text(adb('shell', 'dumpsys', 'window', 'windows'), encoding='utf-8')
        proof['appearanceSelectionsExecuted'] = ['dark', 'light']
        scroll_and_tap(account, {'Créer une entreprise'}, 'account-scroll')
        identity = wait_ui('04-identity', lambda labels: 'Donnons un nom à votre espace.' in labels)
        viewport_before_keyboard = webview_bounds(identity)
        for attempt in range(5):
            fields = [n for n in identity.iter('node') if n.get('class') == 'android.widget.EditText' and bounds(n) and bounds(n)[3]-bounds(n)[1] >= 40]
            if fields:
                x1, y1, x2, y2 = bounds(fields[0])
                adb('shell', 'input', 'tap', str((x1+x2)//2), str((y1+y2)//2))
                break
            scroll(identity)
            identity = snapshot(f'identity-scroll-{attempt+1}')
        else:
            raise RuntimeError('No editable identity field is reachable')
        _, proof['keyboardBeforeTyping'] = wait_keyboard_field('05-keyboard-ready')
        # Avoid a burst of ADB key events racing the first IME/React frame on
        # this translated ARM emulator; every character must still survive.
        marker = 'Zentra-Test'
        for character in marker:
            adb('shell', 'input', 'text', character)
            time.sleep(0.2)
        keyboard = wait_ui('05-identity-keyboard', lambda labels: marker in labels)
        windows = adb('shell', 'dumpsys', 'window')
        (OUT / '05-identity-keyboard-windows.txt').write_text(windows, encoding='utf-8')
        proof['keyboardAfterTyping'] = check_keyboard_field(keyboard, windows)
        adb('shell', 'input', 'keyevent', '4')
        identity = snapshot('06-identity-keyboard-closed')
        if webview_bounds(identity) != viewport_before_keyboard:
            raise RuntimeError('Viewport did not recover after dismissing the keyboard')
        proof['keyboardDismissalRestoresViewport'] = True
        scroll_and_tap(identity, {'Retour'}, 'identity-return')
        wait_ui('07-back-account', lambda labels: bool(account_markers.intersection(labels)))
        proof['identityDraftEdited'] = True
        proof['accountReturnedAfterEditing'] = True
        # Normal app restart, with the native identity and database preserved.
        adb('shell', 'am', 'force-stop', PACKAGE)
        before = profile_state(temp, 'before-restart')
        print('Stopped profile is intact; restarting the application', flush=True)
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
