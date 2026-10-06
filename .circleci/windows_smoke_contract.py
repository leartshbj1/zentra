"""Fresh Windows CI admission; no network except the explicit fetch callback."""
import hashlib
import json
import re
import subprocess
from pathlib import Path

SOURCE = 'c067f2e6bd0c6cbe2dae76162feb88e92f44156b'
VERSION = '1.90.14'
TEST_FLAGS = ('bexioImportTestsPassed', 'catalogImportTestsPassed', 'companyTestsPassed',
              'accountTestsPassed', 'outgoingMailTestsPassed', 'fixedAssetsTestsPassed',
              'inputVatTestsPassed', 'invoiceScanTestsPassed', 'documentCompositionTestsPassed',
              'documentEditorTestsPassed', 'interfaceWorkspaceTestsPassed')

def require(ok, message):
    if not ok:
        raise ValueError(message)

def parameters(environment):
    try:
        job = int(environment.get('ZENTRA_SMOKE_JOB', ''))
    except ValueError:
        raise ValueError('Real Windows build job required before network') from None
    require(job > 0 and job != 275, 'Real Windows build required; failed job 275 is rejected')
    source = environment.get('ZENTRA_SMOKE_SOURCE')
    version = environment.get('ZENTRA_SMOKE_VERSION')
    pipeline = environment.get('ZENTRA_SMOKE_PIPELINE_SOURCE')
    verifier = environment.get('CIRCLE_SHA1')
    require(source == SOURCE and version == VERSION, 'Frozen Windows application source/version required')
    require(isinstance(pipeline, str) and re.fullmatch('[0-9a-f]{40}', pipeline), 'Real Windows build pipeline revision required before network')
    require(isinstance(verifier, str) and re.fullmatch('[0-9a-f]{40}', verifier), 'Real Windows smoke verifier revision required before network')
    return job, source, pipeline, verifier

def checkout(repo, verifier):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()
    require(git('rev-parse', 'HEAD') == verifier, 'Smoke checkout differs from the real verifier revision')
    changes = git('diff', '--name-only', SOURCE, verifier).splitlines()
    require(all(path.startswith('.circleci/') for path in changes), 'Smoke verifier modifies application source')
    require(not git('diff', '--name-only', 'HEAD', '--', 'desktop', '.circleci'), 'Smoke tracked source is modified')
    for relative in ('desktop/package.json', 'desktop/src-tauri/tauri.conf.json'):
        require(json.loads((repo / relative).read_text())['version'] == VERSION, 'Smoke checkout version differs')

def admit(fetch, job, source, pipeline):
    require(job > 0 and job != 275 and source == SOURCE, 'Failed/unpinned Windows application build refused')
    require(isinstance(pipeline, str) and re.fullmatch('[0-9a-f]{40}', pipeline), 'Pinned Windows build pipeline required')
    api = f'https://circleci.com/api/v1.1/project/github/leartshbj1/zentra/{job}'
    build = json.loads(fetch(api))
    require(build.get('status') == 'success', 'Pinned Windows build must succeed before package smoke')
    require(build.get('vcs_revision') == pipeline, 'Windows CI pipeline revision differs')
    artifacts = json.loads(fetch(api + '/artifacts'))
    def download(name):
        records = [entry for entry in artifacts if Path(entry['path'].replace('\\', '/')).name == name]
        require(len(records) == 1, 'Artifact missing or duplicated: ' + name)
        return fetch(records[0]['url'])
    receipts = {name: download(name) for name in ('SOURCE.txt', 'VERIFIER-SOURCE.txt')}
    require(receipts['SOURCE.txt'].decode('utf-8-sig').strip() == source, 'Packaged Windows application source differs')
    require(receipts['VERIFIER-SOURCE.txt'].decode('utf-8-sig').strip() == pipeline, 'Windows build verifier receipt differs')
    proof = json.loads(download('provenance.json'))
    require((proof['source'], proof['version'], proof['target'], proof['identifier']) ==
            (source, VERSION, 'x86_64-pc-windows-msvc', 'ch.helvichantier.desktop'), 'Windows build provenance differs')
    require(all(proof.get(flag) is True for flag in TEST_FLAGS), 'Full Windows release regression evidence missing')
    name = f'Zentra_{VERSION}_x64-setup.exe'
    records = {entry['name']: entry for entry in proof['files']}
    require(len(records) == len(proof['files']) == 2 and set(records) == {'Zentra.exe', name}, 'Unexpected Windows release inventory')
    ci = json.loads(download('windows-ci-proof.json'))
    require((ci['source'], ci['pipelineSource'], ci['buildJob'], ci['version'], ci['target']) ==
            (source, pipeline, job, VERSION, 'x86_64-pc-windows-msvc') and
            ci.get('fullOriginalReleaseCompleted') is True, 'Windows CI completion receipt differs')
    require(ci.get('payloadFiles') == proof['files'], 'Windows CI payload inventory differs')
    receipt_records = {entry['name']: entry for entry in ci['receiptFiles']}
    require(len(receipt_records) == len(ci['receiptFiles']) == 2 and set(receipt_records) == set(receipts), 'Windows CI receipt inventory differs')
    for receipt, data in receipts.items():
        entry = receipt_records[receipt]
        require(entry['sha256'].lower() == hashlib.sha256(data).hexdigest() and entry['size'] == len(data), 'Windows CI source receipt bytes differ')
    payloads = {key: download(key) for key in records}
    for key, data in payloads.items():
        entry = records[key]
        require(hashlib.sha256(data).hexdigest() == entry['sha256'].lower() and len(data) == entry['size'], 'Exact Windows payload bytes differ: ' + key)
    return {'proof': proof, 'payloads': payloads, 'buildPipelineSource': pipeline,
            'installerSha256': records[name]['sha256'].lower(), 'installerBytes': len(payloads[name]),
            'rawExecutableSha256': records['Zentra.exe']['sha256'].lower(), 'rawExecutableBytes': len(payloads['Zentra.exe'])}
