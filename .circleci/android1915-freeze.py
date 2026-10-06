#!/usr/bin/env python3
"""CI-only: keep authored files exact while auditing Tauri's generated schemas."""
import argparse
import hashlib
import json
import math
import re
import subprocess
from pathlib import Path

TRACKED = tuple('desktop/src-tauri/gen/schemas/' + name for name in (
    'acl-manifests.json', 'capabilities.json', 'desktop-schema.json', 'windows-schema.json'))
UNTRACKED = tuple('desktop/src-tauri/gen/schemas/' + name for name in (
    'android-schema.json', 'mobile-schema.json'))
LIMIT = 8 * 1024 * 1024


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.DEVNULL)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key')
        result[key] = value
    return result


def parse_json(data):
    if not 0 < len(data) <= LIMIT:
        raise ValueError('Generated JSON exceeds the bounded size')
    def finite_float(text):
        number = float(text)
        if not math.isfinite(number):
            raise ValueError('Non-finite JSON number')
        return number
    value = json.loads(data.decode('utf-8'), object_pairs_hook=unique_object, parse_float=finite_float,
                       parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Non-finite JSON')))
    if not isinstance(value, dict):
        raise ValueError('Expected a JSON object')
    return value


def strings(value):
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def canonical(value):
    # JSON distinguishes booleans from numbers; Python dict equality does not.
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False)


def capability(author):
    # Exactly the locked tauri-utils 2.9.3 Capability serde defaults; no generic merge.
    if set(author) - {'$schema', 'identifier', 'description', 'remote', 'local',
                      'windows', 'webviews', 'permissions', 'platforms'}:
        raise ValueError('Unknown authored capability field')
    if not isinstance(author.get('identifier'), str) or not author['identifier']:
        raise ValueError('Capability identifier missing')
    result = {'identifier': author['identifier'], 'description': author.get('description', ''),
              'local': author.get('local', True), 'permissions': author.get('permissions')}
    if not isinstance(result['description'], str) or type(result['local']) is not bool:
        raise ValueError('Invalid capability scalar')
    if not isinstance(result['permissions'], list):
        raise ValueError('Capability permissions missing')
    for permission in result['permissions']:
        if isinstance(permission, str):
            continue
        if not isinstance(permission, dict) or set(permission) - {'identifier', 'allow', 'deny'}:
            raise ValueError('Invalid permission entry')
        if not isinstance(permission.get('identifier'), str):
            raise ValueError('Permission identifier missing')
        for scope in ('allow', 'deny'):
            if scope in permission and permission[scope] is not None and not isinstance(permission[scope], list):
                raise ValueError('Invalid permission scope')
        # Option scopes omit None, but Some([]) is retained by serde.
    result['permissions'] = [({key: value for key, value in p.items() if value is not None}
                              if isinstance(p, dict) else p) for p in result['permissions']]
    for key in ('windows', 'webviews'):
        value = author.get(key, [])
        if not strings(value):
            raise ValueError('Invalid capability targets')
        if value:
            result[key] = value
    if author.get('platforms') is not None:
        if not strings(author['platforms']):
            raise ValueError('Invalid capability platforms')
        result['platforms'] = author['platforms']
    if author.get('remote') is not None:
        remote = author['remote']
        if not isinstance(remote, dict) or set(remote) != {'urls'} or not strings(remote['urls']):
            raise ValueError('Invalid capability remote')
        result['remote'] = remote
    return result


def audit(root, source, version, verifier, phase, allow_generated=False):
    if not re.fullmatch(r'[0-9a-f]{40}', source) or not re.fullmatch(r'[0-9a-f]{40}', verifier) or source == verifier:
        raise ValueError('Exact distinct source and verifier revisions required')
    if git(root, 'rev-parse', 'HEAD').decode().strip() != source:
        raise ValueError('Application HEAD differs')
    branch = subprocess.run(['git', '-C', str(root), 'symbolic-ref', '--quiet', 'HEAD'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if branch.returncode != 1:
        raise ValueError('Application must remain detached')
    changed = git(root, 'diff', '--name-only', '-z', 'HEAD').decode('utf-8').split('\0')
    changed = sorted(path for path in changed if path)
    new = git(root, 'ls-files', '--others', '--exclude-standard', '-z').decode('utf-8').split('\0')
    new = sorted(path for path in new if path)
    print(json.dumps({'phase': phase, 'trackedChanged': changed[:16], 'untracked': new[:16],
                      'trackedCount': len(changed), 'untrackedCount': len(new)}), flush=True)
    if set(changed) - (set(TRACKED) if allow_generated else set()):
        raise ValueError('Authored tracked files changed')
    if set(new) - (set(UNTRACKED) if allow_generated else set()):
        raise ValueError('Unexpected untracked application file')
    for relative in ('desktop/package.json', 'desktop/src-tauri/tauri.conf.json'):
        if parse_json((root / relative).read_bytes()).get('version') != version:
            raise ValueError('Frozen JSON version differs')
    for relative, section in (('desktop/src-tauri/Cargo.toml', r'\[package\]'),
                              ('desktop/src-tauri/Cargo.lock', r'\[\[package\]\]')):
        text = (root / relative).read_text(encoding='utf-8')
        if re.findall(section + r'\r?\nname = "helvichantier"\r?\nversion = "([^"]+)"', text) != [version]:
            raise ValueError('Frozen Rust version differs')
    generated, audited_bytes = [], {}
    for relative in TRACKED + UNTRACKED:
        path = root / relative
        if not path.exists():
            if relative in TRACKED:
                raise ValueError('Tracked generated JSON missing')
            continue
        if path.is_symlink() or not path.is_file():
            raise ValueError('Generated JSON must be a regular file')
        data = path.read_bytes()
        parse_json(data)
        audited_bytes[relative] = data
        before = git(root, 'show', source + ':' + relative) if relative in TRACKED else None
        generated.append({'path': relative, 'trackedAtSource': relative in TRACKED,
                          'sourceSha256': hashlib.sha256(before).hexdigest() if before is not None else None,
                          'sourceBytes': len(before) if before is not None else None,
                          'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
                          'changed': before != data})
    authors, author_receipts = {}, []
    author_dir = root / 'desktop/src-tauri/capabilities'
    paths = sorted(author_dir.rglob('*'))
    for path in paths:
        if path.is_dir():
            continue
        if path.is_symlink() or path.suffix != '.json':
            raise ValueError('Unsupported capability author format')
        data = path.read_bytes()
        relative = path.relative_to(root).as_posix()
        if data != git(root, 'show', source + ':' + relative):
            raise ValueError('Authored capability bytes differ from exact source')
        audited_bytes[relative] = data
        expected = capability(parse_json(data))
        if expected['identifier'] in authors:
            raise ValueError('Duplicate authored capability identifier')
        authors[expected['identifier']] = expected
        author_receipts.append({'path': relative,
                                'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})
    if not authors or canonical(parse_json(audited_bytes[TRACKED[1]])) != canonical(authors):
        raise ValueError('Generated capabilities differ from frozen authored capabilities')
    # Detect a late change rather than restoring generated or authored files.
    if git(root, 'rev-parse', 'HEAD').decode().strip() != source:
        raise ValueError('Application HEAD changed during audit')
    if sorted(p for p in git(root, 'diff', '--name-only', '-z', 'HEAD').decode('utf-8').split('\0') if p) != changed:
        raise ValueError('Application tracked files changed during audit')
    if sorted(p for p in git(root, 'ls-files', '--others', '--exclude-standard', '-z').decode('utf-8').split('\0') if p) != new:
        raise ValueError('Application untracked files changed during audit')
    for relative, data in audited_bytes.items():
        if (root / relative).is_symlink() or (root / relative).read_bytes() != data:
            raise ValueError('Audited bytes changed during audit')
    return {'source': source, 'pipelineSource': verifier, 'version': version, 'phase': phase,
            'authoredFilesUnchanged': True, 'generatedCapabilitiesMatchFrozenAuthors': True,
            'allowedGeneratedChanges': allow_generated, 'trackedChanged': changed, 'untrackedGenerated': new,
            'generatedSchemas': generated, 'authoredCapabilities': author_receipts}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('source')
    parser.add_argument('version')
    parser.add_argument('verifier')
    parser.add_argument('phase')
    parser.add_argument('--allow-generated', action='store_true')
    parser.add_argument('--receipt', type=Path)
    args = parser.parse_args()
    if args.receipt and (not args.allow_generated or args.phase != 'build-complete'):
        raise ValueError('Receipt is restricted to completed build audit')
    result = audit(args.root, args.source, args.version, args.verifier, args.phase, args.allow_generated)
    if args.receipt:
        expected = args.root / 'desktop/artifacts/android-build/source-freeze-proof.json'
        if args.receipt.resolve() != expected.resolve():
            raise ValueError('Receipt output scope differs')
        with args.receipt.open('x', encoding='utf-8', newline='\n') as output:
            output.write(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
