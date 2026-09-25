"""Launch an exact CI artifact in a disposable profile, without customer data."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request


def fetch(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != 'https' or not (parsed.hostname == 'circleci.com' or parsed.hostname.endswith('.circle-artifacts.com')):
        raise ValueError('Unexpected CI download endpoint')
    request = urllib.request.Request(url, headers={'Accept': 'application/json'} if 'circleci.com/api/' in url else {})
    with urllib.request.urlopen(request, timeout=180) as response:
        if urllib.parse.urlparse(response.url).scheme != 'https':
            raise ValueError('Insecure artifact redirect')
        data = response.read(300 * 1024 * 1024 + 1)
        if len(data) > 300 * 1024 * 1024:
            raise ValueError('Artifact too large')
        return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('system', choices=['windows', 'macos'])
    parser.add_argument('job', type=int)
    parser.add_argument('source')
    args = parser.parse_args()
    assert args.job > 0 and re.fullmatch('[a-f0-9]{40}', args.source)
    assert platform.system() == {'windows': 'Windows', 'macos': 'Darwin'}[args.system]
    repo = Path(__file__).resolve().parents[2]
    version = json.loads((repo / 'desktop/package.json').read_text())['version']
    schema = int(re.search(r'SCHEMA_VERSION:\s*i64\s*=\s*(\d+)', (repo / 'desktop/src-tauri/src/schema.rs').read_text()).group(1))
    api = f'https://circleci.com/api/v1.1/project/github/leartshbj1/zentra/{args.job}'
    build = json.loads(fetch(api))
    assert build['status'] == 'success' and build['vcs_revision'] == args.source
    artifacts = json.loads(fetch(api + '/artifacts'))
    records = {Path(a['path']).name: a for a in artifacts
               if args.system == 'windows' or '/macos/' in '/' + a['path'].replace('\\', '/')}
    root = Path(tempfile.mkdtemp(prefix='zentra-installer-cloud-smoke-'))
    out = repo / 'desktop/artifacts/smoke'
    out.mkdir(parents=True, exist_ok=True)

    def download(name):
        data = fetch(records[name]['url'])
        target = root / name
        target.write_bytes(data)
        return target

    if args.system == 'windows':
        proof = json.loads(download('provenance.json').read_text())
        assert proof['source'] == args.source and proof['version'] == version
        assert proof['identifier'] == 'ch.helvichantier.desktop'
        assert proof['companyTestsPassed'] and proof['accountTestsPassed']
        name = f'Zentra_{version}_x64-setup.exe'
        installer = download(name)
        hashes = {f['name']: f['sha256'] for f in proof['files']}
        assert hashlib.sha256(installer.read_bytes()).hexdigest() == hashes[name]
        original = download('Zentra.exe').read_bytes()
        assert hashlib.sha256(original).hexdigest() == hashes['Zentra.exe']
        # Tauri 2.11.4 patches the first bundle-type marker when packaging NSIS
        # and restores the loose build executable afterwards. Reproduce that
        # documented transform, then require an exact hash of every byte.
        # https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle.rs
        marker = b'__TAURI_BUNDLE_TYPE_VAR_UNK'
        assert original.count(marker) == 1
        packaged = original.replace(marker, b'__TAURI_BUNDLE_TYPE_VAR_NSS', 1)
        expected_payload = hashlib.sha256(packaged).hexdigest()
        install_dir = root / 'application'
        subprocess.run([str(installer), '/S', '/D=' + str(install_dir)], check=True, timeout=180)
        exe = install_dir / 'Zentra.exe'
        # NSIS can hand off to a child installer. Wait for the exact payload,
        # rather than reading the executable while the child is extracting it.
        deadline = time.monotonic() + 30
        actual_hash = None
        while time.monotonic() < deadline:
            if exe.is_file():
                actual_hash = hashlib.sha256(exe.read_bytes()).hexdigest()
                if actual_hash == expected_payload:
                    break
            time.sleep(1)
        if actual_hash != expected_payload:
            evidence = dict(expected=expected_payload, original=hashes['Zentra.exe'], actual=actual_hash,
                            installedBytes=exe.stat().st_size if exe.is_file() else None)
            print(json.dumps(evidence), flush=True)
            (out / 'installer-mismatch.json').write_text(json.dumps(evidence, indent=2))
            if exe.is_file():
                shutil.copy2(exe, out / 'installed-Zentra.exe')
            raise RuntimeError('Installed executable differs from the verified build payload')
    else:
        assert download('SOURCE.txt').read_text().strip() == args.source
        name = f'Zentra_{version}_macos-universal.app.tar.gz'
        archive = download(name)
        sums = dict((line.split(maxsplit=1)[1].removeprefix('./'), line.split()[0]) for line in download('SHA256SUMS.txt').read_text().splitlines())
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == sums[name]
        with tarfile.open(archive) as source:
            source.extractall(root, filter='data')
        app = root / 'Zentra.app'
        subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
        exe = app / 'Contents/MacOS/Zentra'
        subprocess.run(['lipo', str(exe), '-verify_arch', 'arm64', 'x86_64'], check=True)
    profile = root / 'profile'
    profile.mkdir()
    env = {**os.environ, 'HELVICHANTIER_DATA_DIR': str(profile)}
    log = out / f'{args.system}-startup.log'
    for attempt in range(2):
        with log.open('ab') as stream:
            proc = subprocess.Popen([str(exe)], env=env, stdout=stream, stderr=stream)
            try:
                deadline = time.monotonic() + 60
                while True:
                    if proc.poll() is not None:
                        raise RuntimeError('Packaged application exited before initialization')
                    try:
                        db_path = (profile / 'helvichantier.sqlite3').resolve()
                        # WAL readers may need to create the shared-memory
                        # sidecar, even though every query is read-only.
                        # mode=rw cannot create a missing database, so only the
                        # packaged app can satisfy the initialization check.
                        # https://www.sqlite.org/wal.html#read_only_databases
                        with closing(sqlite3.connect(db_path.as_uri() + '?mode=rw', uri=True)) as db:
                            db.execute('PRAGMA query_only=ON')
                            assert db.execute('PRAGMA user_version').fetchone()[0] == schema
                            assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
                            assert db.execute('PRAGMA foreign_key_check').fetchall() == []
                        break
                    except (sqlite3.Error, AssertionError) as db_error:
                        if time.monotonic() >= deadline:
                            raise RuntimeError(f'Packaged database validation failed: {db_error}') from db_error
                        time.sleep(1)
                time.sleep(5)
                assert proc.poll() is None
            except Exception as error:
                # Preserve actionable evidence even when startup stops before
                # logging is available. Never inspect a customer profile.
                stream.flush()
                evidence = dict(error=str(error), attempt=attempt + 1,
                                processExit=proc.poll(), profile=str(profile), sqliteVersion=sqlite3.sqlite_version,
                                profileFiles=[str(p.relative_to(profile)) for p in profile.rglob('*')],
                                startupLog=log.read_text(errors='replace')[-8000:])
                (out / f'{args.system}-failure.json').write_text(json.dumps(evidence, indent=2))
                print(json.dumps(evidence), flush=True)
                if args.system == 'macos' and proc.poll() is None:
                    sample = out / 'macos-startup-sample.txt'
                    subprocess.run(['/usr/bin/sample', str(proc.pid), '3', '1', '-file', str(sample)],
                                   timeout=20, check=False)
                    if sample.exists():
                        print(sample.read_text(errors='replace')[:16000], flush=True)
                raise
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    proc.wait(timeout=20)
    result = dict(version=version, source=args.source, system=args.system, buildJob=args.job,
                  verifierSource=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip(),
                  schema=schema, integrity='ok', isolatedProfile=True, startupAndRelaunchPassed=True,
                  sqliteVersion=sqlite3.sqlite_version, databaseAccess='existing-file-only, query_only=ON',
                  scope='Packaged binary startup and SQLite integrity, without interactive UI or customer data')
    if args.system == 'windows':
        result.update(installedExecutableSha256=expected_payload,
                      rawExecutableSha256=hashes['Zentra.exe'], nsisBundleMarkerVerified=True)
    (out / f'{args.system}-smoke.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
