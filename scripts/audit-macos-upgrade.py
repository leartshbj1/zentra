"""Exercise immutable macOS packages on a disposable runner, with no user data."""

import importlib.util
from contextlib import contextmanager
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request


def run(*args):
    return subprocess.check_output(args, text=True).strip()


@contextmanager
def isolated_keychain(root):
    """Use an owned test keychain so normal consent never needs a runner password."""
    previous_default = run('security', 'default-keychain').strip('"')
    keychain = root / 'zentra-upgrade-test.keychain-db'
    password = secrets.token_urlsafe(32)

    def security(*args):
        result = subprocess.run(['security', *args], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError('Isolated test keychain operation failed')

    created = False
    try:
        security('create-keychain', '-p', password, str(keychain))
        created = True
        security('set-keychain-settings', '-lut', '3600', str(keychain))
        security('unlock-keychain', '-p', password, str(keychain))
        security('default-keychain', '-s', str(keychain))
        yield password
    finally:
        security('default-keychain', '-s', previous_default)
        if created:
            security('delete-keychain', str(keychain))


def main():
    assert sys.platform == 'darwin' and os.environ.get('GITHUB_ACTIONS') == 'true'
    assert os.environ.get('GITHUB_REPOSITORY') == 'leartshbj1/zentra'
    source = os.environ['ZENTRA_NATIVE_SOURCE']
    expected = os.environ['ZENTRA_CURRENT_SHA256'].lower()
    build_run = os.environ['ZENTRA_BUILD_RUN']
    assert re.fullmatch(r'[0-9a-f]{40}', source)
    assert re.fullmatch(r'[0-9a-f]{64}', expected) and build_run.isdigit()
    assert not run('git', 'diff', '--name-only', source, 'HEAD', '--', 'desktop', 'pnpm-lock.yaml', 'pnpm-workspace.yaml')
    build = json.loads(run('gh', 'run', 'view', build_run, '--json', 'headSha,conclusion,workflowName'))
    assert build == {'headSha': source, 'conclusion': 'success', 'workflowName': 'Zentra macOS updater package'}
    spec = importlib.util.spec_from_file_location('profile_fixture', Path(__file__).with_name('verify-windows-release-profile.py'))
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    report_dir = Path('outputs/macos-upgrade-audit')
    report_dir.mkdir(parents=True, exist_ok=True)
    report = {'version': '1.46.1', 'previousVersion': '1.45.0', 'nativeSource': source,
              'auditSource': run('git', 'rev-parse', 'HEAD'), 'buildRun': int(build_run),
              'passed': False, 'stages': [], 'scope': 'Exact archive replacement, native startup, restart, SQLite and protected identity; no interactive UI, Gatekeeper or notarization claim.'}
    runner_temp = Path(os.environ['RUNNER_TEMP']).resolve()
    with tempfile.TemporaryDirectory(prefix='zentra-macos-upgrade-', dir=runner_temp) as temp, isolated_keychain(Path(temp)) as keychain_password:
        root = Path(temp).resolve()
        assert root.parent == runner_temp
        profile = root / 'profile'
        profile.mkdir()
        current = list(Path('outputs/macos-upgrade-input').rglob('Zentra_1.46.1_macos-universal.app.tar.gz'))
        assert len(current) == 1 and fixture.digest(current[0]) == expected
        previous = root / 'previous.tar.gz'
        url = 'https://xvfohjdlhlirksrvkiqu.supabase.co/storage/v1/object/public/zentra-releases/Zentra_1.45.0_macos-universal.app.tar.gz'
        with urllib.request.urlopen(url, timeout=60) as response, previous.open('wb') as target:
            shutil.copyfileobj(response, target)
        previous_hash = '18fce57d9f5c0551302402c266db1b06c5f05e2ad5743fe5250025caf256a691'
        assert fixture.digest(previous) == previous_hash
        report.update(currentArchiveSha256=expected, previousArchiveSha256=previous_hash)
        install = root / 'Applications'

        def unpack(archive, version):
            assert install.parent == root and root.parent == runner_temp
            if install.exists():
                shutil.rmtree(install)
            install.mkdir()
            with tarfile.open(archive) as bundle:
                bundle.extractall(install, filter='data')
            apps = list(install.glob('*.app'))
            assert len(apps) == 1
            info = plistlib.loads((apps[0] / 'Contents/Info.plist').read_bytes())
            assert info['CFBundleIdentifier'] == 'ch.zentra.desktop'
            assert info['CFBundleShortVersionString'] == version
            executable = apps[0] / 'Contents/MacOS' / info['CFBundleExecutable']
            subprocess.run(['codesign', '--verify', '--deep', '--strict', str(apps[0])], check=True)
            assert set(run('lipo', '-archs', str(executable)).split()) == {'arm64', 'x86_64'}
            return executable

        def start_and_stop(executable, schema, stage):
            env = dict(os.environ, HELVICHANTIER_DATA_DIR=str(profile))
            with (root / (stage + '.log')).open('wb') as log:
                process = subprocess.Popen([str(executable)], env=env, stdout=log, stderr=log)
                try:
                    deadline = time.monotonic() + 50
                    consent_checked = False
                    while True:
                        assert process.poll() is None, stage + ': packaged app exited during initialization'
                        try:
                            with sqlite3.connect((profile / 'helvichantier.sqlite3').as_uri() + '?mode=ro', uri=True) as connection:
                                observed = connection.execute('PRAGMA user_version').fetchone()[0]
                                integrity = connection.execute('PRAGMA integrity_check').fetchone()[0]
                            if observed == schema and integrity == 'ok' and (profile / 'installation-identity.protected').is_file():
                                break
                        except sqlite3.Error:
                            pass
                        if stage != 'previous' and not consent_checked and time.monotonic() > deadline - 43:
                            consent_checked = True
                            # An ad hoc update has a new code identity. Exercise the normal macOS
                            # Allow action only for this test application's own Keychain dialog.
                            # Never alter ACLs or disable Keychain security. The only password
                            # available here belongs to the disposable keychain created above.
                            consent_script = '''tell application "System Events"
tell process "SecurityAgent"
if (count of windows) is not 1 then return "no-single-consent-dialog"
set dialogText to ""
set dialogElements to entire contents of window 1
repeat with dialogElement in dialogElements
try
set currentElement to contents of dialogElement
if role of currentElement is "AXStaticText" then set dialogText to dialogText & (value of currentElement as text) & " "
on error inspectionError
set dialogText to dialogText & "[inspection: " & inspectionError & "] "
end try
end repeat
if dialogText does not contain "Zentra" or dialogText does not contain "ch.zentra.desktop.protected-data" then return "unexpected-consent-context: " & dialogText
if not (exists button "Allow" of window 1) then return "no-allow-button"
set passwordFields to {}
repeat with dialogElement in dialogElements
set currentElement to contents of dialogElement
if role of currentElement is "AXTextField" then
if subrole of currentElement is "AXSecureTextField" then set end of passwordFields to currentElement
end if
end repeat
if (count of passwordFields) > 1 then return "unexpected-password-fields"
if (count of passwordFields) is 1 then set value of item 1 of passwordFields to system attribute "ZENTRA_QA_KEYCHAIN_PASSWORD"
click button "Allow" of window 1
return "allowed-zentra-keychain-dialog; test-password-fields=" & (count of passwordFields)
end tell
end tell'''
                            consent = subprocess.run(['osascript', '-e', consent_script], capture_output=True, text=True, timeout=10,
                                                     env=dict(os.environ, ZENTRA_QA_KEYCHAIN_PASSWORD=keychain_password))
                            report.setdefault('systemConsent', []).append({'stage': stage, 'result': consent.stdout.strip(), 'inspectionError': consent.stderr.strip()})
                        assert time.monotonic() < deadline, stage + ': initialization timed out'
                        time.sleep(1)
                    # LocalStore unlocks the Keychain identity before opening or migrating SQLite.
                    # Reaching schema 59 proves that unlock completed during this upgrade.
                    time.sleep(8)
                    assert process.poll() is None, stage + ': packaged app exited after migration'
                    report['stages'].append({'stage': stage, 'schema': schema, 'processAliveAfterInitialization': True})
                finally:
                    if time.monotonic() >= deadline and process.poll() is None:
                        report['timeoutDiagnostic'] = {'stage': stage, 'schema': observed}
                        try:
                            sample = subprocess.run(['sample', str(process.pid), '1', '1'], capture_output=True, text=True, timeout=15)
                            relevant = [line.strip() for line in sample.stdout.splitlines() if any(word in line.lower() for word in ['keychain', 'secitem', 'security', 'load_or_create', 'unprotect', 'migrate'])]
                            report['timeoutDiagnostic']['stackFrames'] = relevant[:60]
                            # Read only the labels of any system consent dialog on this disposable runner.
                            consent = subprocess.run(['osascript', '-e', 'tell application "System Events" to get {name of every window, name of every button of every window} of process "SecurityAgent"'], capture_output=True, text=True, timeout=10)
                            report['timeoutDiagnostic']['consentLabels'] = consent.stdout.strip()
                            report['timeoutDiagnostic']['consentInspectionError'] = consent.stderr.strip()
                        except (OSError, subprocess.TimeoutExpired) as error:
                            report['timeoutDiagnostic']['inspectionError'] = type(error).__name__
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=10)

        try:
            old_app = unpack(previous, '1.45.0')
            start_and_stop(old_app, 58, 'previous')
            database = profile / 'helvichantier.sqlite3'
            identity = profile / 'installation-identity.protected'
            assert identity.read_bytes().startswith(b'zentra-keychain-v1:')
            identity_hash = fixture.digest(identity)
            with sqlite3.connect(database) as connection:
                connection.execute('PRAGMA foreign_keys=ON')
                fixture.seed(connection, profile)
                baseline = fixture.rows(connection)
            attachment_hash = fixture.digest(profile / 'attachments/qa-plan.txt')
            new_app = unpack(current[0], '1.46.1')
            for stage in ['upgrade', 'restart']:
                start_and_stop(new_app, 59, stage)
                with sqlite3.connect(database) as connection:
                    assert connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
                    assert not connection.execute('PRAGMA foreign_key_check').fetchall()
                    observed = fixture.rows(connection)
                    assert all(observed[name] == values for name, values in baseline.items())
                    assert not connection.execute('SELECT journal_entry_id FROM journal_lines GROUP BY journal_entry_id HAVING SUM(debit_cents) != SUM(credit_cents)').fetchall()
                    assert connection.execute('SELECT COUNT(*) FROM shared_numbering_binding').fetchone()[0] == 0
                assert fixture.digest(identity) == identity_hash
                assert fixture.digest(profile / 'attachments/qa-plan.txt') == attachment_hash
            report.update(passed=True, integrity='ok', foreignKeysValid=True, businessRowsPreserved=True,
                          balancedJournalsPreserved=True, attachmentBytesPreserved=True,
                          protectedInstallationIdentityPreserved=True, sharedNumberingNotActivated=True)
        finally:
            (report_dir / 'upgrade-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
