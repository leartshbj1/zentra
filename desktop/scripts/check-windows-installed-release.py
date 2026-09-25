"""Check the actual NSIS-installed payload, without executing the loose build binary.

The installer smoke and local isolated-profile smoke must already have passed.
This check never installs, signs, modifies binaries or changes Windows security.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def check(build_dir, cloud_smoke, local_smoke, installed_executable, source):
    require(re.fullmatch(r'[a-f0-9]{40}', source), 'Expected an exact application source revision')
    build_dir = Path(build_dir)
    build, cloud, local = read(build_dir / 'provenance.json'), read(cloud_smoke), read(local_smoke)
    version = build['version']
    require(build['source'] == cloud['source'] == local['source'] == source, 'Source revision differs')
    require(version == cloud['version'] == local['version'], 'Release version differs')
    require(build['target'] == local['target'] == 'x86_64-pc-windows-msvc', 'Unexpected Windows target')
    require(build['identifier'] == 'ch.helvichantier.desktop', 'Unexpected Windows application')
    require(build['companyTestsPassed'] and build['accountTestsPassed'], 'Native regression checks missing')
    for proof in (cloud, local):
        require(proof['startupAndRelaunchPassed'] and proof['isolatedProfile'] and proof['integrity'] == 'ok', 'Installed startup or integrity check missing')
    require(cloud['system'] == 'windows' and cloud['nsisBundleMarkerVerified'], 'Installer payload check missing')
    require(local['installedPackage'], 'Local evidence must concern the installed application')
    records = {item['name']: item for item in build['files']}
    require(len(records) == len(build['files']) and set(records) == {'Zentra.exe', f'Zentra_{version}_x64-setup.exe'}, 'Unexpected build artifact inventory')
    for name, record in records.items():
        path = build_dir / name
        require(path.stat().st_size == record['size'] and digest(path) == record['sha256'].lower(), 'Build artifact changed')
    require(cloud['rawExecutableSha256'].lower() == records['Zentra.exe']['sha256'].lower(), 'Cloud test used a different build')
    installed_hash = digest(installed_executable)
    require(installed_hash == cloud['installedExecutableSha256'].lower() == local['applicationSha256'].lower(), 'Installed executable differs from the tested installer payload')
    return dict(version=version, source=source, installedApplicationSha256=installed_hash,
                installedPayloadVerified=True, startupAndRelaunchPassed=True,
                rawBuildLaunchRequired=False, securitySettingsChanged=False)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build-dir', required=True)
    parser.add_argument('--cloud-smoke', required=True)
    parser.add_argument('--local-smoke', required=True)
    parser.add_argument('--installed-executable', required=True)
    parser.add_argument('--source', required=True)
    args = parser.parse_args()
    print(json.dumps(check(**vars(args))))
