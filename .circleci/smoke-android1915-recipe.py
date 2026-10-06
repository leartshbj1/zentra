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
import statistics
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET

HERE = Path(os.environ['ZENTRA_ANDROID_SMOKE_APP_ROOT']) / 'desktop/scripts'
OUT = Path(os.environ['ZENTRA_ANDROID_SMOKE_VERIFIER_ROOT']) / 'desktop/artifacts/android-release-smoke'
OUT.mkdir(parents=True, exist_ok=True)
JOB = int(os.environ.get('ZENTRA_ANDROID_SMOKE_JOB', '167'))
REVISION = os.environ.get('ZENTRA_ANDROID_SMOKE_SOURCE', '958787be4e608b89a357f98c73d0c236bda677b4')
SHA = os.environ.get('ZENTRA_ANDROID_SMOKE_SHA256', '5d0b410c900881d60354293976d4f1d7f52db1cef9381766a724ce69dba075d6')
PACKAGE = 'ch.zentra.mobile'
VERSION = json.loads((HERE.parents[1] / 'desktop/package.json').read_text(encoding='utf-8'))['version']
EXPECTED_SCHEMA = int(re.search(r'SCHEMA_VERSION:\s*i64\s*=\s*(\d+)', (HERE.parents[1] / 'desktop/src-tauri/src/schema.rs').read_text(encoding='utf-8')).group(1))
PROFILE = '/data/user/0/' + PACKAGE
INPUT_OBSERVATIONS = {}


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def run(*args, binary=False, timeout=45):
    return subprocess.check_output(args, text=not binary, timeout=timeout).strip()


def adb(*args, **kwargs):
    return run('adb', '-s', 'emulator-5554', *args, **kwargs)


def capture_screen(label, timeout=30):
    # Do not strip PNG bytes: trailing whitespace can be part of the checksum.
    png = subprocess.check_output(['adb', '-s', 'emulator-5554', 'exec-out', 'screencap', '-p'], timeout=timeout)
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


def diagnostic_write(path, value):
    try:
        path.write_text(value, encoding='utf-8')
        return True
    except OSError as error:
        try:
            print(f'Diagnostic write failed: {path.name}: {type(error).__name__}', file=sys.stderr)
        except OSError:
            pass
        return False


def input_diagnostics(label):
    """Bounded observations of this disposable fixture, never recovery actions."""
    observations = {}
    commands = {
        'pressure': ('shell', 'cat', '/proc/pressure/cpu', '/proc/pressure/memory', '/proc/loadavg'),
        'processes': ('shell', 'top', '-b', '-n', '1', '-m', '12'),
        'windows': ('shell', 'dumpsys', 'window', 'windows'),
    }
    for name, command in commands.items():
        try:
            saved = diagnostic_write(OUT / f'{label}-{name}.txt', adb(*command, timeout=8))
            observations[name] = 'captured' if saved else 'write_failed'
        except (OSError, subprocess.SubprocessError) as error:
            observations[name] = type(error).__name__
    return observations


def diagnosed_tap(x, y, label, target):
    # One native tap only. Command completion is not evidence of a UI click;
    # the unchanged destination-screen assertion remains authoritative.
    # Record in memory only. Additional ADB calls or file writes here would give
    # the UI extra settling time before its unchanged destination assertion.
    record = {'target': target, 'x': x, 'y': y, 'nativeTapAttempts': 1,
              'beforeScreenshot': '01-welcome.png', 'destinationScreenshot': '02-account.png'}
    INPUT_OBSERVATIONS[label] = record
    started = time.monotonic_ns()
    try:
        adb('shell', 'input', 'tap', str(x), str(y))
        record['commandCompleted'] = True
    except (OSError, subprocess.SubprocessError) as error:
        record['commandCompleted'] = False
        record['commandError'] = type(error).__name__
        raise
    finally:
        record['commandDurationMs'] = (time.monotonic_ns() - started) / 1_000_000


def collect_input_observations():
    # Only after the complete recipe passed or failed. These observations must
    # not delay a gesture or extend any screen deadline. Existing screenshots
    # come from the original UI wait; fixture state below is explicitly later.
    for label, record in INPUT_OBSERVATIONS.items():
        try:
            capture_screen(label + '-after-recipe', timeout=10)
            record['afterRecipeScreenshot'] = 'captured'
        except (OSError, subprocess.SubprocessError) as error:
            record['afterRecipeScreenshot'] = type(error).__name__
        record['afterRecipeState'] = input_diagnostics(label + '-after-recipe')
        diagnostic_write(OUT / (label + '-input.json'), json.dumps(record, indent=2) + '\n')


def tap(root, labels, diagnostic_label=None):
    matches = [n for n in root.iter('node') if (n.get('text') or n.get('content-desc')) in labels]
    # Android exposes both a control and its label. Prefer the actual control;
    # never tap [0,0][0,0] from an off-screen accessibility node.
    for node in sorted(matches, key=lambda n: n.get('clickable') != 'true'):
        box = bounds(node)
        if box and box[3]-box[1] >= 24 and node.get('enabled') == 'true':
            x1, y1, x2, y2 = box
            x, y = (x1+x2)//2, (y1+y2)//2
            if diagnostic_label:
                diagnosed_tap(x, y, diagnostic_label, dict(node.attrib))
            else:
                adb('shell', 'input', 'tap', str(x), str(y))
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
    # Android exposes both the native viewport and a nested accessibility
    # document as WebView. Focus/scroll can offset the document by a pixel;
    # only the outer native viewport represents IME and system-bar insets.
    boxes = []
    def visit(node, inside_webview=False):
        is_webview = node.get('class') == 'android.webkit.WebView'
        if is_webview and not inside_webview and bounds(node):
            boxes.append(bounds(node))
        for child in node:
            visit(child, inside_webview or is_webview)
    visit(root)
    if len(boxes) != 1:
        raise RuntimeError('Exactly one visible native WebView viewport is required')
    return boxes[0]


def check_native_bars(root, screenshot, window_dump, dark):
    width, height, rgb = module('screenshot_pixels', 'ios_icons.py').pixels(screenshot)
    viewport = webview_bounds(root)
    bands = {'status': (0, viewport[1]), 'navigation': (viewport[3], height)}
    medians = {}
    for name, (start, end) in bands.items():
        if end-start < 4:
            raise RuntimeError('Expected native safe area is missing: ' + name)
        # A central rectangle avoids the clock/battery; the median ignores the
        # narrow gesture handle. Check real pixels, not just selected options.
        samples = [rgb[(y*width+x)*3+channel]
                   for y in range(start+(end-start)//4, end-(end-start)//4)
                   for x in range(width*35//100, width*65//100)
                   for channel in range(3)]
        medians[name] = statistics.median(samples)
        if (dark and medians[name] > 80) or (not dark and medians[name] < 190):
            raise RuntimeError('Native safe area does not match the theme: ' + name)
    app_windows = [block for block in re.split(r'\n\s*Window #', window_dump)
                   if 'package=ch.zentra.mobile ' in block and 'isVisible=true' in block]
    if len(app_windows) != 1:
        raise RuntimeError('Visible application window is ambiguous')
    appearance = re.search(r'\bapr=([^\n]+)', app_windows[0])
    appearance = appearance[1] if appearance else ''
    for flag in ('LIGHT_STATUS_BARS', 'LIGHT_NAVIGATION_BARS'):
        if (flag in appearance) == dark:
            raise RuntimeError('Native system icon contrast does not match the theme')
    return {'backgroundMedians': medians, 'dark': dark, 'iconAppearance': appearance}


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
    if integrity != 'ok' or foreign_keys or schema != EXPECTED_SCHEMA:
        raise RuntimeError('Native profile failed integrity or schema checks')
    return {'identitySha256': identity_hash, 'schema': schema, 'integrity': integrity, 'foreignKeyErrors': 0}


def ensure_emulator_root():
    # ADB may close its transport while adbd restarts. A non-zero command alone
    # is not accepted: reconnect once and prove the required emulator/root state.
    # No root retry, no physical device, and no application assertion is skipped.
    outcome = {'rootCommandExit': 0}
    try:
        adb('root')
    except subprocess.CalledProcessError as error:
        outcome['rootCommandExit'] = error.returncode
    adb('wait-for-device')
    if adb('shell', 'getprop', 'ro.kernel.qemu') != '1':
        raise RuntimeError('Root setup must remain on the disposable emulator')
    if adb('shell', 'id', '-u') != '0':
        raise RuntimeError('Disposable emulator root is required to inspect a non-debuggable profile')
    outcome['emulatorAndRootVerified'] = True
    return outcome


def main():
    if JOB <= 0 or not re.fullmatch(r'[0-9a-f]{40}', REVISION) or not re.fullmatch(r'[0-9a-f]{64}', SHA):
        raise ValueError('An exact source job, revision and independently recorded hash are required')
    if adb('shell', 'getprop', 'ro.kernel.qemu') != '1':
        raise RuntimeError('Refusing to operate on a physical device')
    abi = adb('shell', 'getprop', 'ro.product.cpu.abilist')
    if 'arm64-v8a' not in abi.split(','):
        raise RuntimeError('This emulator does not expose ARM64 translation')
    print(f'Disposable emulator ready; supported ABIs: {abi}', flush=True)
    root_setup = ensure_emulator_root()
    if PACKAGE in adb('shell', 'pm', 'list', 'packages'):
        raise RuntimeError('Expected a fresh emulator without Zentra')
    # The stock Messages app raised its own ANR dialog in recipe 170 while
    # Zentra remained responsive. Remove that unrelated fixture interference
    # only on the fresh, rooted emulator verified above. Never suppress ANRs
    # globally or dismiss a Zentra failure dialog.
    disabled_fixture_packages = []
    messaging = 'com.google.android.apps.messaging'
    if 'package:' + messaging in adb('shell', 'pm', 'list', 'packages').splitlines():
        result = adb('shell', 'pm', 'disable-user', '--user', '0', messaging)
        if 'new state: disabled-user' not in result:
            raise RuntimeError('Could not isolate the disposable emulator from Messages')
        disabled_fixture_packages.append(messaging)
    fetch = module('cloud_fetch', 'cloud-package-smoke.py').fetch
    verifier = module('preview_verify', 'verify-android-preview.py')
    release = module('candidate_check', 'check-android-release.py')
    api = f'https://circleci.com/api/v1.1/project/github/leartshbj1/zentra/{JOB}'
    job = json.loads(fetch(api))
    if job['status'] != 'success' or job['vcs_revision'] != os.environ['ZENTRA_ANDROID_SMOKE_PIPELINE_SOURCE']:
        raise RuntimeError('Unexpected source build')
    records = {Path(a['path']).name: a for a in json.loads(fetch(api + '/artifacts'))}
    tools = Path(os.environ['ANDROID_HOME']) / 'build-tools/36.0.0'
    proof = {'source': REVISION, 'sourceJob': JOB, 'unsignedSha256': SHA, 'emulatorAbis': abi,
             'signingIdentity': 'disposable-emulator-only', 'physicalDeviceTested': False, 'published': False}
    proof['rootSetup'] = root_setup
    proof['displaySize'] = adb('shell', 'wm', 'size')
    proof['disabledEmulatorFixturePackages'] = disabled_fixture_packages
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
        proof['manifest'] = release.check_manifest(badging, tree, VERSION)
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
        # sys.boot_completed may precede telephony registration on a loaded
        # emulator. Require the actual service before issuing its command.
        phone_deadline = time.monotonic() + 60
        while adb('shell', 'service', 'check', 'phone').strip() != 'Service phone: found':
            if time.monotonic() >= phone_deadline:
                raise RuntimeError('Disposable emulator phone service did not become ready')
            time.sleep(2)
        adb('shell', 'svc', 'data', 'disable')
        adb('logcat', '-c')
        started = time.monotonic()
        proof['launch'] = adb('shell', 'am', 'start', '-W', '-n', PACKAGE + '/.MainActivity')
        capture_screen('00-first-frame')
        starts = {'Commencer', 'Start', 'Inizia', 'Beginnen'}
        welcome = wait_ui('01-welcome', lambda labels: bool(starts.intersection(labels)), seconds=150)
        proof['accessibleWelcomeObservedMs'] = round((time.monotonic()-started)*1000)
        print(f'Usable welcome interface observed after {proof["accessibleWelcomeObservedMs"]} ms, including accessibility inspection', flush=True)
        if not tap(welcome, starts, diagnostic_label='01-welcome-start'):
            raise RuntimeError('Welcome start control is not usable')
        account_markers = {'Tout commence avec vous.', 'It all starts with you.', 'Alles beginnt mit Ihnen.', 'Tutto inizia da te.'}
        account = wait_ui('02-account', lambda labels: bool(account_markers.intersection(labels)))
        proof['accountScreenVisible'] = True
        proof['accountHeader'] = check_account_header(account)
        proof['nativeThemes'] = {}
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
            windows = adb('shell', 'dumpsys', 'window', 'windows')
            (OUT / ('window-' + mode + '.txt')).write_text(windows, encoding='utf-8')
            proof['nativeThemes'][mode] = check_native_bars(account,
                (OUT / ('02-account-' + mode + '.png')).read_bytes(), windows, mode == 'Sombre')
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


def collect_final_logs():
    # Keep crash evidence on failure too; do not overwrite the original error.
    for name, args in (('runtime', ('logcat', '-d')), ('crash', ('logcat', '-b', 'crash', '-d'))):
        try:
            diagnostic_write(OUT / (name + '.log'), adb(*args, timeout=15))
        except (OSError, subprocess.SubprocessError) as error:
            diagnostic_write(OUT / (name + '-collection-error.txt'), type(error).__name__)


if __name__ == '__main__':
    try:
        main()
    finally:
        collect_final_logs()
        collect_input_observations()
