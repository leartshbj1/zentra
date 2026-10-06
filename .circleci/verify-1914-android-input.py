import hashlib, json, os, re, runpy
from pathlib import Path

def require(ok, message):
    if not ok:
        raise ValueError(message)

job = int(os.environ["ZENTRA_SMOKE_JOB"])
source = os.environ["ZENTRA_SMOKE_SOURCE"]
version = os.environ["ZENTRA_SMOKE_VERSION"]
require(job > 0 and re.fullmatch(r"[0-9a-f]{40}", source), "Pinned source job and revision required")
require(version == "1.90.14", "Expected version 1.90.14")
require(json.loads(Path("desktop/package.json").read_text())["version"] == version, "Verifier package version differs")
require(json.loads(Path("desktop/src-tauri/tauri.conf.json").read_text())["version"] == version, "Verifier Tauri version differs")
sha = os.environ["ZENTRA_ANDROID_SMOKE_SHA256"]
require(re.fullmatch(r"[0-9a-f]{64}", sha), "Independently verified Android276 SHA256 required")
fetch = runpy.run_path("desktop/scripts/cloud-package-smoke.py")["fetch"]
api = f"https://circleci.com/api/v1.1/project/github/leartshbj1/zentra/{job}"
build = json.loads(fetch(api))
require(build.get("status") == "success" and build.get("vcs_revision") == source, "Pinned build must succeed before package smoke")
artifacts = json.loads(fetch(api + "/artifacts"))
def download(name):
    records = [a for a in artifacts if Path(a["path"]).name == name]
    require(len(records) == 1, "Artifact missing or duplicated: " + name)
    return fetch(records[0]["url"])
proof = json.loads(download("release-candidate-proof.json"))
require((proof["source"], proof["version"], proof["sha256"]) == (source, version, sha), "Android build provenance differs")
require(proof["package"] == "ch.zentra.mobile" and not proof["debuggable"] and not proof["testOnly"], "Android release manifest differs")
name = "Zentra-android-build-release.apk"
apk = download(name)
require(hashlib.sha256(apk).hexdigest() == sha, "Exact Android276 APK bytes differ")
out = Path("desktop/artifacts/android-release-smoke")
out.mkdir(parents=True, exist_ok=True)
(out / "android-input-proof.json").write_text(json.dumps({"version": version, "source": source, "buildJob": job, "buildStatus": "success", "artifact": name, "bytes": len(apk), "sha256": sha}, indent=2) + "\n")
print("Verified successful source job and exact Android release APK")
