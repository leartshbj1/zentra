#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == Darwin ]] || { echo 'This check requires macOS.' >&2; exit 1; }
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
desktop_root="$(cd "$script_dir/.." && pwd)"
app="$desktop_root/src-tauri/target/universal-apple-darwin/release/bundle/macos/Zentra.app"
executable="$app/Contents/MacOS/Zentra"
[[ -x "$executable" ]] || { echo 'Packaged executable is missing.' >&2; exit 1; }
version="$(node -p "JSON.parse(require('fs').readFileSync('$desktop_root/package.json','utf8')).version")"
artifact_root="$desktop_root/artifacts/macos-updater-$version"
[[ -d "$artifact_root" ]] || { echo 'The signed updater lot is missing.' >&2; exit 1; }
architectures="$(lipo -archs "$executable")"
[[ " $architectures " == *' arm64 '* && " $architectures " == *' x86_64 '* ]] || { echo 'Both universal architectures are required.' >&2; exit 1; }
codesign --verify --deep --strict "$app"
profile="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/zentra-macos-smoke.XXXXXX")"
HELVICHANTIER_DATA_DIR="$profile" "$executable" > "$artifact_root/smoke-macos.log" 2>&1 &
smoke_pid=$!
cleanup() { kill "$smoke_pid" 2>/dev/null || true; wait "$smoke_pid" 2>/dev/null || true; }
trap cleanup EXIT
python3 - "$profile" "$smoke_pid" "$app" "$desktop_root" "$version" "$artifact_root" "$architectures" <<'PY'
import json,os,plistlib,re,sqlite3,sys,time
from pathlib import Path
profile,pid,app,desktop,version,artifacts,architectures=sys.argv[1:]
pid=int(pid)
metadata=plistlib.loads((Path(app)/'Contents/Info.plist').read_bytes())
assert metadata['CFBundleIdentifier']=='ch.zentra.desktop', metadata['CFBundleIdentifier']
assert metadata['CFBundleShortVersionString']==version, metadata['CFBundleShortVersionString']
schema=int(re.search(r'SCHEMA_VERSION:\s*i64\s*=\s*(\d+)',(Path(desktop)/'src-tauri/src/schema.rs').read_text()).group(1))
database=Path(profile)/'helvichantier.sqlite3'
deadline=time.monotonic()+45
while True:
    os.kill(pid,0)
    try:
        with sqlite3.connect(database.as_uri()+'?mode=ro',uri=True) as connection:
            observed=connection.execute('PRAGMA user_version').fetchone()[0]
            integrity=connection.execute('PRAGMA integrity_check').fetchone()[0]
            settings=connection.execute('SELECT COUNT(*) FROM settings').fetchone()[0]
        if observed==schema and integrity=='ok' and settings==0:
            break
    except sqlite3.Error:
        pass
    if time.monotonic()>=deadline:
        raise RuntimeError('Packaged app did not initialize the expected isolated database.')
    time.sleep(1)
time.sleep(5)
os.kill(pid,0)
proof={'version':version,'identifier':metadata['CFBundleIdentifier'],'architectures':architectures.split(),'schema':observed,'integrity':integrity,'settings':settings,'isolatedProfile':True,'processAliveAfterInitialization':True,'scope':'Packaged executable startup and real SQLite initialization; no interactive UI or Apple notarization claim.'}
(Path(artifacts)/'smoke-macos.json').write_text(json.dumps(proof,indent=2)+'\n')
print(json.dumps(proof))
PY
