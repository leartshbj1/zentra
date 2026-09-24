"""Verify and launch the freshly packaged Mac archive without account data."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import sqlite3
import subprocess
import tarfile
import tempfile
import time


def main():
    assert platform.system() == 'Darwin', 'This check requires a real macOS runner'
    repo = Path(__file__).resolve().parents[2]
    version = json.loads((repo/'desktop/package.json').read_text())['version']
    source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip()
    artifacts = repo/'desktop/artifacts/macos'
    assert (artifacts/'SOURCE.txt').read_text().strip() == source
    name = f'Zentra_{version}_macos-universal.app.tar.gz'
    archive = artifacts/name
    sums = {line.split(maxsplit=1)[1].removeprefix('./'): line.split()[0]
            for line in (artifacts/'SHA256SUMS.txt').read_text().splitlines()}
    archive_hash = hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()
    assert archive_hash == sums[name]
    schema = int(re.search(r'SCHEMA_VERSION:\s*i64\s*=\s*(\d+)',
                          (repo/'desktop/src-tauri/src/schema.rs').read_text()).group(1))
    output = repo/'desktop/artifacts/smoke'
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='zentra-mac-package-') as temporary:
        root = Path(temporary)
        with tarfile.open(archive) as package:
            package.extractall(root, filter='data')
        app = root/'Zentra.app'
        executable = app/'Contents/MacOS/Zentra'
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
        subprocess.run(['lipo', str(executable), '-verify_arch', 'arm64', 'x86_64'], check=True)
        profile = root/'profile'
        profile.mkdir()
        environment = {**os.environ, 'HELVICHANTIER_DATA_DIR': str(profile)}
        for attempt in range(2):
            with (output/'macos-startup.log').open('ab') as log:
                process = subprocess.Popen([str(executable)], env=environment, stdout=log, stderr=log)
                try:
                    deadline = time.monotonic()+60
                    while True:
                        assert process.poll() is None, 'Packaged application exited before initialization'
                        try:
                            uri = (profile/'helvichantier.sqlite3').resolve().as_uri()+'?mode=rw'
                            with closing(sqlite3.connect(uri, uri=True)) as connection:
                                connection.execute('PRAGMA query_only=ON')
                                assert connection.execute('PRAGMA user_version').fetchone()[0] == schema
                                assert connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
                                assert not connection.execute('PRAGMA foreign_key_check').fetchall()
                            break
                        except (sqlite3.Error, AssertionError):
                            if time.monotonic() >= deadline:
                                raise
                            time.sleep(1)
                    time.sleep(5)
                    assert process.poll() is None
                finally:
                    if process.poll() is None:
                        process.terminate()
                        process.wait(timeout=20)
    result = {'version': version, 'source': source, 'system': 'macos',
              'buildJob': int(os.environ.get('CIRCLE_BUILD_NUM', '0')),
              'schema': schema, 'integrity': 'ok', 'isolatedProfile': True,
              'startupAndRelaunchPassed': True, 'archiveSha256': archive_hash,
              'universalArchitecturesVerified': True, 'codeSignatureVerified': True,
              'scope': 'Packaged app launch and relaunch on macOS; no customer data or interactive UI test'}
    (output/'macos-smoke.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
