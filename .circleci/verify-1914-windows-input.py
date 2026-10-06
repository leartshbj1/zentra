"""CI-only admission; never install a package before fresh build verification."""
import json
import os
from pathlib import Path
import runpy
import windows_smoke_contract as contract

def main():
    job, source, pipeline, verifier = contract.parameters(os.environ)
    repo = Path.cwd()
    contract.checkout(repo, verifier)
    out = repo / 'desktop/artifacts/smoke'
    contract.require(not out.exists() or not any(out.iterdir()), 'Refusing inherited Windows smoke evidence')
    fetch = runpy.run_path(str(repo / 'desktop/scripts/cloud-package-smoke.py'))['fetch']
    admitted = contract.admit(fetch, job, source, pipeline)
    proof = {'version': contract.VERSION, 'source': source, 'buildJob': job,
             'buildPipelineSource': pipeline, 'verifierSource': verifier, 'buildStatus': 'success',
             'target': 'x86_64-pc-windows-msvc', 'artifact': f'Zentra_{contract.VERSION}_x64-setup.exe',
             'bytes': admitted['installerBytes'], 'sha256': admitted['installerSha256']}
    out.mkdir(parents=True, exist_ok=True)
    (out / 'windows-input-proof.json').write_text(json.dumps(proof, indent=2) + '\n')
    print('Verified fresh Windows build, distinct verifier and exact NSIS bytes')

if __name__ == '__main__':
    main()
