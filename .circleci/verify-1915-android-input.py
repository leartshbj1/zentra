"""CI-only admission. Never start an emulator before successful exact build reads."""
import importlib.util
import json
import os
from pathlib import Path
import android_smoke_contract as contract

def main():
    verifier = contract.parameters(os.environ)
    repo = Path(__file__).resolve().parents[1]
    app = repo / '.zentra-android-source'
    contract.require(Path(os.environ['ZENTRA_ANDROID_SMOKE_APP_ROOT']).resolve() == app.resolve(), 'Frozen application location differs')
    contract.require(Path(os.environ['ZENTRA_ANDROID_SMOKE_VERIFIER_ROOT']).resolve() == repo.resolve(), 'Smoke output location differs')
    contract.checkout(repo, app, verifier)
    out = repo / 'desktop/artifacts/android-release-smoke'
    contract.require(not out.exists() or not any(out.iterdir()), 'Refusing inherited Android smoke output')
    spec = importlib.util.spec_from_file_location('frozen_cloud_fetch', app / 'desktop/scripts/cloud-package-smoke.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    evidence = contract.admit(module.fetch)
    evidence['verifierSource'] = verifier
    out.mkdir(parents=True, exist_ok=True)
    (out / 'android-input-proof.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print('Verified successful Android 286, frozen application, distinct pipeline and exact APK bytes')

if __name__ == '__main__':
    main()
