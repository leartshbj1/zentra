"""Strict read-only Android input admission. No emulator, payment or signing."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

SOURCE = '0d2571a741883add178b485e8a1ad4d0222d4204'
PIPELINE = 'c5cd0c494b8d6b6110cd052fad3a75823d010196'
APK_SHA256 = '7cfc9225ee23b9eed11ec6dd92638134e7851ab024f3c904d087de0e0d498cec'
VERSION = '1.90.15'
JOB = 286

def require(ok, message):
    if not ok:
        raise ValueError(message)

def parameters(environment):
    require(environment.get('CIRCLECI') == 'true', 'CircleCI is required before input reads')
    require(environment.get('CIRCLE_BRANCH') == 'codex/release-1.90.15-smoke-android-20261006', 'Exact Android smoke branch required')
    require(environment.get('CIRCLE_JOB') == 'android-package-smoke-1915', 'Exact Android smoke job required')
    verifier = environment.get('CIRCLE_SHA1')
    require(isinstance(verifier, str) and re.fullmatch('[0-9a-f]{40}', verifier) and verifier not in (SOURCE, PIPELINE) and not re.fullmatch('0+', verifier), 'Real distinct smoke verifier required')
    require(isinstance(environment.get('CIRCLE_BUILD_NUM'), str) and re.fullmatch('[1-9][0-9]*', environment['CIRCLE_BUILD_NUM']), 'Real smoke job number required')
    for key, value in {
        'ZENTRA_SMOKE_JOB': str(JOB), 'ZENTRA_ANDROID_SMOKE_JOB': str(JOB),
        'ZENTRA_SMOKE_SOURCE': SOURCE, 'ZENTRA_ANDROID_SMOKE_SOURCE': SOURCE,
        'ZENTRA_SMOKE_PIPELINE_SOURCE': PIPELINE, 'ZENTRA_ANDROID_SMOKE_PIPELINE_SOURCE': PIPELINE,
        'ZENTRA_SMOKE_VERSION': VERSION, 'ZENTRA_ANDROID_SMOKE_SHA256': APK_SHA256,
    }.items():
        require(environment.get(key) == value, 'Frozen Android input pin differs: ' + key)
    require(re.fullmatch('[0-9a-f]{40}', SOURCE) and re.fullmatch('[0-9a-f]{64}', APK_SHA256), 'Generated source and independently verified APK hash required')
    return verifier

def checkout(repo, app, verifier):
    def git(root, *args):
        return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
    require(git(repo, 'rev-parse', 'HEAD') == verifier, 'Smoke checkout differs from actual verifier')
    expected = {'.circleci/config.yml', '.circleci/android-smoke1915-controller.sh', '.circleci/smoke-android1915-recipe.sh',
                '.circleci/smoke-android1915-recipe.py', '.circleci/android_smoke_contract.py', '.circleci/verify-1915-android-input.py'}
    changes = git(repo, 'diff', '--name-only', SOURCE, verifier).splitlines()
    require(len(changes) == len(expected) and set(changes) == expected, 'Android smoke verifier changes unexpected source files')
    require(not git(repo, 'status', '--porcelain', '--untracked-files=all', '--', '.circleci'), 'CI controls are modified')
    require(git(app, 'rev-parse', 'HEAD') == SOURCE, 'Frozen Android reference differs')
    detached = subprocess.run(['git', '-C', str(app), 'symbolic-ref', '--quiet', 'HEAD'], text=True, capture_output=True)
    require(detached.returncode == 1, 'Frozen Android reference must be detached')
    require(not git(app, 'diff', '--name-only', 'HEAD'), 'Frozen Android reference changed')
    for root in (repo, app):
        for relative in ('desktop/package.json', 'desktop/src-tauri/tauri.conf.json'):
            require(json.loads((root / relative).read_text())['version'] == VERSION, 'Reference JSON version differs')
        for relative, section in (('desktop/src-tauri/Cargo.toml', r'\[package\]'), ('desktop/src-tauri/Cargo.lock', r'\[\[package\]\]')):
            matches = re.findall(section + r'\r?\nname = "helvichantier"\r?\nversion = "([^"]+)"', (root / relative).read_text())
            require(matches == [VERSION], 'Reference Rust version differs')

def verify_evidence(build, candidate, completion, source_receipt, verifier_receipt, apk, freeze_bytes):
    require(isinstance(build, dict) and type(build.get('build_num')) is int and build['build_num'] == JOB, 'Exact retry build number required')
    require(isinstance(build, dict) and build.get('status') == 'success' and build.get('vcs_revision') == PIPELINE, 'Android build must actually succeed on the pinned pipeline')
    require(isinstance(apk, bytes) and len(apk) > 0 and hashlib.sha256(apk).hexdigest() == APK_SHA256, 'Exact independently verified APK bytes differ')
    require(source_receipt.decode('utf-8-sig').strip() == SOURCE, 'Packaged Android application receipt differs')
    require(verifier_receipt.decode('utf-8-sig').strip() == PIPELINE, 'Packaged Android verifier receipt differs')
    require((candidate.get('source'), candidate.get('version'), candidate.get('package'), candidate.get('sha256')) == (SOURCE, VERSION, 'ch.zentra.mobile', APK_SHA256), 'Android release candidate identity differs')
    require(type(candidate.get('bytes')) is int and candidate['bytes'] == len(apk), 'Android candidate byte count differs')
    for key in ('debuggable', 'testOnly', 'backupAllowed', 'signatureVerified', 'physicalDeviceTested', 'emulatorTested', 'published'):
        require(candidate.get(key) is False, 'Android candidate requires a strict false flag: ' + key)
    require(type(candidate.get('versionCode')) is int and candidate['versionCode'] == 1090015, 'Android version code differs')
    require(type(candidate.get('minimumSdk')) is int and candidate['minimumSdk'] == 24 and type(candidate.get('targetSdk')) is int and candidate['targetSdk'] == 36, 'Android SDK bounds differ')
    libraries = candidate.get('nativeLibraries')
    require(isinstance(libraries, list) and len(libraries) > 0, 'Android native libraries absent')
    require(all(isinstance(item, dict) and isinstance(item.get('path'), str) and item['path'].startswith('lib/arm64-v8a/')
                and item['path'].endswith('.so') and type(item.get('loadSegments')) is int and item['loadSegments'] > 0 for item in libraries), 'Android library admission differs')
    require((completion.get('source'), completion.get('pipelineSource'), completion.get('version')) == (SOURCE, PIPELINE, VERSION), 'Android CI completion identity differs')
    require(type(completion.get('buildJob')) is int and completion['buildJob'] == JOB, 'Android CI completion job differs')
    require(completion.get('applicationCheckoutDetached') is True and completion.get('releaseBuildCompleted') is True, 'Android CI completion requires strict success flags')
    require(completion.get('originalReleaseCommand') == 'desktop/scripts/codemagic-android.sh', 'Android CI recipe differs')
    for key in ('signatureVerified', 'emulatorTested', 'physicalDeviceTested', 'published'):
        require(completion.get(key) is False, 'Android CI requires a strict false flag: ' + key)
    payload = completion.get('payload')
    require(isinstance(payload, dict) and (payload.get('name'), payload.get('sha256')) == ('Zentra-android-build-release.apk', APK_SHA256)
            and type(payload.get('bytes')) is int and payload['bytes'] == len(apk), 'Android CI payload differs')
    freeze = verify_freeze(completion, freeze_bytes)
    return {'sourceFreezeProof': freeze, 'version': VERSION, 'source': SOURCE, 'buildJob': JOB, 'buildPipelineSource': PIPELINE,
            'buildStatus': 'success', 'artifact': payload['name'], 'bytes': len(apk), 'sha256': APK_SHA256}

def artifact_record(artifacts, name):
    require(isinstance(artifacts, list), 'Android artifact inventory is ambiguous')
    records = [item for item in artifacts if isinstance(item, dict) and isinstance(item.get('path'), str) and Path(item['path'].replace('\\', '/')).name == name]
    require(len(records) == 1, 'Artifact missing or duplicated: ' + name)
    require(isinstance(records[0].get('url'), str), 'Artifact URL is absent')
    return records[0]

def admit(fetch):
    api = f'https://circleci.com/api/v1.1/project/github/leartshbj1/zentra/{JOB}'
    build = json.loads(fetch(api))
    require(type(build.get('build_num')) is int and build['build_num'] == JOB, 'Exact retry build number required before artifact reads')
    require(build.get('status') == 'success' and build.get('vcs_revision') == PIPELINE, 'Android build must succeed before APK admission')
    artifacts = json.loads(fetch(api + '/artifacts'))
    def download(name):
        return fetch(artifact_record(artifacts, name)['url'])
    return verify_evidence(build, json.loads(download('release-candidate-proof.json')), json.loads(download('android-ci-proof.json')),
                           download('SOURCE.txt'), download('VERIFIER-SOURCE.txt'), download('Zentra-android-build-release.apk'), download('source-freeze-proof.json'))

# Added CI-only admission of the fresh source audit; product recipe is unchanged.
import math
FROZEN_CAPABILITIES = {"desktop/src-tauri/capabilities/default.json":{"sha256":"59b9590e0f9902463b80f6ba9772c3a5dbe8746ee5bed791ab75c47bf8ba8790","bytes":256},"desktop/src-tauri/capabilities/ios-navigation.json":{"sha256":"202108bacd72f5c23b5c00724f2df190c1439d98f3af498646518bee9de83cef","bytes":222},"desktop/src-tauri/capabilities/mobile.json":{"sha256":"98830cc184a1088c667ede0452c78fa87d8bf5f1600b63e8c1a11affec3f9cd3","bytes":353}}
FROZEN_SCHEMAS = {"desktop/src-tauri/gen/schemas/acl-manifests.json":{"sha256":"5519c3ce70ed83cadaec09bb0e4f703ad29d17e755e5cfa97026c4092392aabd","bytes":70072},"desktop/src-tauri/gen/schemas/capabilities.json":{"sha256":"e49ffd5f86f4755245fcabb7f56a08eb0d75b3b24c849a426e05e4a184326d1f","bytes":765},"desktop/src-tauri/gen/schemas/desktop-schema.json":{"sha256":"b0db3c2e2fe2f1257a33a04b1cdfbce35ee7cd054220999d2e7a44a56afacb25","bytes":123209},"desktop/src-tauri/gen/schemas/windows-schema.json":{"sha256":"b0db3c2e2fe2f1257a33a04b1cdfbce35ee7cd054220999d2e7a44a56afacb25","bytes":123209}}
NEW_SCHEMAS = ["desktop/src-tauri/gen/schemas/android-schema.json","desktop/src-tauri/gen/schemas/mobile-schema.json"]
PLUGIN_DOCS = ["desktop/plugins/zentra-mobile/permissions/autogenerated/commands/configure_navigation.toml","desktop/plugins/zentra-mobile/permissions/autogenerated/reference.md","desktop/plugins/zentra-mobile/permissions/schemas/schema.json"]

def verify_freeze(completion, data):
    require(isinstance(data, bytes) and 0 < len(data) <= 1024 * 1024, 'Bounded source-freeze receipt required')
    link = completion.get('sourceFreezeProof')
    require(isinstance(link, dict) and link.get('name') == 'source-freeze-proof.json'
            and link.get('sha256') == hashlib.sha256(data).hexdigest()
            and type(link.get('bytes')) is int and link['bytes'] == len(data), 'Source-freeze hash/bytes linkage differs')
    def unique(pairs):
        value = {}
        for key, item in pairs:
            require(key not in value, 'Duplicate source-freeze key')
            value[key] = item
        return value
    def finite_float(text):
        value = float(text)
        require(math.isfinite(value), 'Non-finite source-freeze number')
        return value
    proof = json.loads(data.decode('utf-8'), object_pairs_hook=unique, parse_float=finite_float,
                       parse_constant=lambda _: require(False, 'Non-finite source-freeze JSON'))
    require(isinstance(proof, dict) and (proof.get('source'), proof.get('pipelineSource'), proof.get('version'), proof.get('phase'))
            == (SOURCE, PIPELINE, VERSION, 'build-complete'), 'Source-freeze identity differs')
    for key in ('authoredFilesUnchanged', 'generatedCapabilitiesMatchFrozenAuthors', 'allowedGeneratedChanges',
                'generatedMobilePluginPermissionsMatchFrozenCommand'):
        require(proof.get(key) is True, 'Source-freeze strict flag absent: ' + key)
    authors = proof.get('authoredCapabilities')
    require(isinstance(authors, list) and len(authors) == len(FROZEN_CAPABILITIES), 'Capability audit inventory differs')
    seen = set()
    for item in authors:
        require(isinstance(item, dict) and isinstance(item.get('path'), str) and item['path'] in FROZEN_CAPABILITIES
                and item['path'] not in seen, 'Unexpected capability audit path')
        seen.add(item['path']); expected = FROZEN_CAPABILITIES[item['path']]
        require(item.get('sha256') == expected['sha256'] and type(item.get('bytes')) is int
                and item['bytes'] == expected['bytes'], 'Capability audit differs from exact frozen author')
    plugin = proof.get('generatedMobilePluginPermissions')
    require(isinstance(plugin, list) and len(plugin) == len(PLUGIN_DOCS), 'Mobile plugin audit inventory differs')
    seen = set()
    for item in plugin:
        require(isinstance(item, dict) and isinstance(item.get('path'), str) and item['path'] in PLUGIN_DOCS
                and item['path'] not in seen, 'Unknown mobile plugin generated permission path')
        seen.add(item['path'])
        require(isinstance(item.get('sha256'), str) and re.fullmatch('[0-9a-f]{64}', item['sha256'])
                and type(item.get('bytes')) is int and 0 < item['bytes'] <= 8 * 1024 * 1024, 'Mobile plugin audit hash/size differs')
    schemas = proof.get('generatedSchemas')
    require(isinstance(schemas, list) and 4 <= len(schemas) <= 6, 'Generated schema inventory bound differs')
    seen = set(); new = set()
    for item in schemas:
        require(isinstance(item, dict) and isinstance(item.get('path'), str) and item['path'] not in seen, 'Ambiguous generated schema path')
        path = item['path']; seen.add(path)
        require(path in FROZEN_SCHEMAS or path in NEW_SCHEMAS, 'Unknown generated schema path')
        require(isinstance(item.get('sha256'), str) and re.fullmatch('[0-9a-f]{64}', item['sha256'])
                and type(item.get('bytes')) is int and 0 < item['bytes'] <= 8 * 1024 * 1024
                and type(item.get('changed')) is bool, 'Invalid generated schema hash/size/flag')
        if path in FROZEN_SCHEMAS:
            expected = FROZEN_SCHEMAS[path]
            require(item.get('trackedAtSource') is True and item.get('sourceSha256') == expected['sha256']
                    and type(item.get('sourceBytes')) is int and item['sourceBytes'] == expected['bytes'], 'Schema baseline differs')
        else:
            new.add(path)
            require(item.get('trackedAtSource') is False and item.get('sourceSha256') is None
                    and item.get('sourceBytes') is None and item['changed'] is True, 'New schema baseline differs')
    require(set(FROZEN_SCHEMAS) <= seen, 'Tracked schema audit incomplete')
    changes = proof.get('trackedChanged'); untracked = proof.get('untrackedGenerated')
    require(isinstance(changes, list) and all(isinstance(path, str) for path in changes)
            and len(changes) == len(set(changes)) and set(changes) <= set(FROZEN_SCHEMAS), 'Authored tracked change admitted')
    require(isinstance(untracked, list) and all(isinstance(path, str) for path in untracked)
            and len(untracked) == len(set(untracked)) and set(untracked) == new | set(PLUGIN_DOCS), 'Unknown untracked source admitted')
    return {'sha256': link['sha256'], 'bytes': len(data), 'authoredCapabilitiesExact': True,
            'generatedSchemaCount': len(schemas), 'generatedMobilePluginPermissions': len(plugin)}
