"""Exercise exact APK bytes on a disposable CI emulator; retain every failed case."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time

PACKAGE = 'ch.zentra.mobile'
OUT = Path('desktop/artifacts/android-audit')


def adb(*args, timeout=30, check=True):
    return subprocess.run(['adb', *args], capture_output=True, timeout=timeout, check=check).stdout


def guard():
    assert os.environ.get('CI') == 'true'
    assert os.environ.get('ZENTRA_STARTUP_AUDIT') == os.environ.get('GITHUB_RUN_ID')
    assert os.environ.get('GITHUB_RUN_ID', '').isdigit()
    assert adb('get-serialno').decode().strip().startswith('emulator-')
    assert adb('shell', 'getprop', 'ro.kernel.qemu').strip() == b'1'


def verify_apk(folder):
    apk = folder / 'app-x86_64-debug.apk'
    report = json.loads((folder / 'signing-report.json').read_text())
    expected = next(item for item in report if item['name'] == apk.name)
    assert expected['certificateSha256'] == Path('desktop/android-preview-certificate.sha256').read_text().strip()
    assert hashlib.sha256(apk.read_bytes()).hexdigest() == expected['sha256']
    return apk, expected['sha256']


def wait_for_welcome(folder):
    start = time.monotonic()
    deadline = start + 80
    while time.monotonic() < deadline:
        if not adb('shell', 'pidof', PACKAGE, check=False).strip():
            return False, round(time.monotonic() - start, 2)
        try:
            adb('shell', 'uiautomator', 'dump', '--compressed', '/sdcard/zentra-audit.xml', timeout=15, check=False)
            ui = adb('exec-out', 'cat', '/sdcard/zentra-audit.xml', check=False)
            (folder / 'ui.xml').write_bytes(ui)
            if b'Restaurer une sauvegarde' in ui:
                return True, round(time.monotonic() - start, 2)
        except subprocess.TimeoutExpired:
            pass
        time.sleep(2)
    return False, round(time.monotonic() - start, 2)


def capture(folder, failed):
    (folder / 'screen.png').write_bytes(adb('exec-out', 'screencap', '-p', check=False))
    (folder / 'runtime.log').write_bytes(adb('logcat', '-d', '-s', 'AndroidRuntime:E', check=False))
    if failed:
        subprocess.run(['node', 'desktop/scripts/diagnose-android-startup.mjs'], timeout=75, check=False)
        diagnostic = Path('desktop/artifacts/android/startup-diagnostic.json')
        if diagnostic.exists():
            shutil.copyfile(diagnostic, folder / 'diagnostic.json')
        (folder / 'logcat.log').write_bytes(adb('logcat', '-d', check=False))


def profile_state():
    # Called only after force-stop: SQLite and WAL form a stable snapshot.
    with tempfile.TemporaryDirectory(prefix='zentra-startup-db-') as temp:
        db = Path(temp) / 'app.sqlite3'
        db.write_bytes(adb('exec-out', 'run-as', PACKAGE, 'cat', './helvichantier.sqlite3'))
        wal = adb('exec-out', 'run-as', PACKAGE, 'cat', './helvichantier.sqlite3-wal', check=False)
        if wal:
            db.with_name(db.name + '-wal').write_bytes(wal)
        with sqlite3.connect(db) as conn:
            return {'schema': conn.execute('PRAGMA user_version').fetchone()[0],
                    'integrity': conn.execute('PRAGMA integrity_check').fetchone()[0],
                    'settings': conn.execute('SELECT count(*) FROM settings').fetchone()[0]}


def run_case(apk, digest, label, install_mode, scenario, records):
    guard()
    name = f'{label}-{install_mode}-{scenario}'
    folder = OUT / name
    folder.mkdir(parents=True, exist_ok=False)
    # This workflow created this emulator; no real device or user installation is eligible.
    adb('uninstall', PACKAGE, check=False)
    options = ['--no-incremental'] if install_mode == 'full' else []
    installation = adb('install', *options, str(apk.resolve()), timeout=90)
    (folder / 'install.log').write_bytes(installation)
    adb('logcat', '-c')
    record = {'name': name, 'sha256': digest, 'scenario': scenario, 'mode': install_mode, 'checks': []}
    records.append(record)
    try:
        adb('shell', 'am', 'start', '-W', '-n', PACKAGE + '/.MainActivity')
        if scenario == 'interrupted':
            # Interrupt after native storage appears, before requiring a finished UI.
            for _ in range(40):
                if b'installation-identity.protected' in adb('exec-out', 'run-as', PACKAGE, 'find', '.', '-maxdepth', '1', '-type', 'f', check=False):
                    break
                time.sleep(0.25)
            adb('shell', 'am', 'force-stop', PACKAGE)
            adb('shell', 'am', 'start', '-W', '-n', PACKAGE + '/.MainActivity')
        ok, elapsed = wait_for_welcome(folder)
        record['checks'].append({'phase': scenario, 'welcome': ok, 'seconds': elapsed})
        capture(folder, not ok)
        if ok:
            identity = adb('exec-out', 'run-as', PACKAGE, 'cat', './installation-identity.protected')
            for attempt in range(3):
                adb('shell', 'am', 'force-stop', PACKAGE)
                adb('shell', 'am', 'start', '-W', '-n', PACKAGE + '/.MainActivity')
                ok, elapsed = wait_for_welcome(folder)
                same_identity = adb('exec-out', 'run-as', PACKAGE, 'cat', './installation-identity.protected') == identity
                record['checks'].append({'phase': f'restart-{attempt + 1}', 'welcome': ok, 'seconds': elapsed, 'identityPreserved': same_identity})
                if not ok or not same_identity:
                    capture(folder, True)
                    break
        adb('shell', 'am', 'force-stop', PACKAGE)
        record['profile'] = profile_state()
    except Exception as error:
        record['failure'] = type(error).__name__
    record['passed'] = bool(record.get('profile', {}).get('integrity') == 'ok' and len(record['checks']) == 4
                            and all(c['welcome'] and c.get('identityPreserved', True) for c in record['checks']))
    (OUT / 'report.json').write_text(json.dumps(records, indent=2) + '\n')
    print(json.dumps(record), flush=True)


if __name__ == '__main__':
    guard()
    OUT.mkdir(parents=True, exist_ok=True)
    Path('desktop/artifacts/android').mkdir(parents=True, exist_ok=True)
    records = []
    selected = set(filter(None, os.environ.get('ZENTRA_AUDIT_CASES', '').split(',')))
    known_cases = {f'{label}-{mode}-{scenario}' for label in ['previous', 'current']
                   for mode in ['default', 'full'] for scenario in ['cold', 'interrupted']}
    assert selected <= known_cases, 'Unknown startup case requested'
    for label, folder in zip(['previous', 'current'], map(Path, sys.argv[1:])):
        apk, digest = verify_apk(folder)
        for mode in ['default', 'full']:
            for scenario in ['cold', 'interrupted']:
                if selected and f'{label}-{mode}-{scenario}' not in selected:
                    continue
                run_case(apk, digest, label, mode, scenario, records)
    assert len(records) == (len(selected) or 8)
    if not all(r['passed'] for r in records):
        raise SystemExit('Android startup audit found incomplete or failed journeys; inspect report.json')
