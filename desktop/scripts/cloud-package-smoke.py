"""Launch an exact CI artifact in a disposable profile, without customer data."""
import argparse
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
import urllib.parse
import urllib.request


def fetch(url):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != 'https' or not (parsed.hostname == 'circleci.com' or parsed.hostname.endswith('.circle-artifacts.com')):
        raise ValueError('Unexpected CI download endpoint')
    with urllib.request.urlopen(url, timeout=180) as response:
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
        install_dir = root / 'application'
        subprocess.run([str(installer), '/S', '/D=' + str(install_dir)], check=True, timeout=180)
        exe = install_dir / 'Zentra.exe'
        assert hashlib.sha256(exe.read_bytes()).hexdigest() == hashes['Zentra.exe']
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
                        db_path = profile / 'helvichantier.sqlite3'
                        with sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True) as db:
                            assert db.execute('PRAGMA user_version').fetchone()[0] == schema
                            assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
                            assert db.execute('PRAGMA foreign_key_check').fetchall() == []
                        break
                    except (sqlite3.Error, AssertionError):
                        if time.monotonic() >= deadline:
                            raise RuntimeError('Packaged application did not initialize its database')
                        time.sleep(1)
                time.sleep(5)
                assert proc.poll() is None
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    proc.wait(timeout=20)
    result = dict(version=version, source=args.source, system=args.system, buildJob=args.job,
                  schema=schema, integrity='ok', isolatedProfile=True, startupAndRelaunchPassed=True,
                  scope='Packaged binary startup and SQLite integrity, without interactive UI or customer data')
    (out / f'{args.system}-smoke.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
