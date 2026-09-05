"""Strip native debug symbols, realign and sign with the durable preview identity.

Only debuggable APKs are accepted. Production/store signing is deliberately separate.
"""

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile


def run(*args: str) -> None:
    subprocess.run(args, check=True)


sdk = Path(os.environ["ANDROID_HOME"])
build_tools = sdk / "build-tools/36.0.0"
strip = sdk / "ndk/27.2.12479018/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip"
sources = sorted(Path(sys.argv[1]).rglob("*debug.apk"))
if not sources:
    raise SystemExit("No debug APKs found")
output = Path(sys.argv[2])
output.mkdir(parents=True, exist_ok=True)

with tempfile.TemporaryDirectory(prefix="zentra-preview-") as temp:
    staging = Path(temp)
    keystore = staging / "preview.p12"
    encoded = os.environ.pop("ZENTRA_ANDROID_PREVIEW_KEYSTORE", "")
    if not encoded or not os.environ.get("ZENTRA_ANDROID_PREVIEW_KEYSTORE_PASSWORD"):
        raise SystemExit("The protected Android preview signing identity is required; refusing key rotation")
    keystore.write_bytes(base64.b64decode(encoded, validate=True))
    keystore.chmod(0o600)
    del encoded
    pin = (Path(__file__).parents[1] / "android-preview-certificate.sha256").read_text().strip().lower()
    certificate = subprocess.check_output([
        "keytool", "-exportcert", "-keystore", str(keystore), "-storetype", "PKCS12",
        "-storepass:env", "ZENTRA_ANDROID_PREVIEW_KEYSTORE_PASSWORD", "-alias", "zentra-preview",
    ])
    if not re.fullmatch(r"[0-9a-f]{64}", pin) or hashlib.sha256(certificate).hexdigest() != pin:
        raise SystemExit("Android preview certificate does not match the pinned identity")
    reports = []
    for source in sources:
        manifest = subprocess.check_output([str(build_tools / "aapt"), "dump", "badging", str(source)], text=True)
        if "application-debuggable" not in manifest.splitlines():
            raise SystemExit(f"Refusing a non-debuggable APK: {source.name}")
        unsigned = staging / "unsigned.apk"
        with zipfile.ZipFile(source) as original, zipfile.ZipFile(unsigned, "w") as compact:
            for entry in original.infolist():
                if re.fullmatch(r"META-INF/(MANIFEST\.MF|[^/]+\.(SF|RSA|DSA|EC))", entry.filename, re.IGNORECASE):
                    continue
                data = original.read(entry)
                if re.fullmatch(r"lib/(arm64-v8a|x86_64)/[^/]+\.so", entry.filename):
                    native = staging / "native.so"
                    native.write_bytes(data)
                    run(str(strip), "--strip-unneeded", str(native))
                    data = native.read_bytes()
                compact.writestr(entry, data)
        aligned = staging / "aligned.apk"
        run(str(build_tools / "zipalign"), "-P", "16", "-f", "4", str(unsigned), str(aligned))
        target = output / source.name
        run(str(build_tools / "apksigner"), "sign", "--ks", str(keystore), "--ks-type", "PKCS12", "--ks-key-alias",
            "zentra-preview", "--ks-pass", "env:ZENTRA_ANDROID_PREVIEW_KEYSTORE_PASSWORD",
            "--key-pass", "env:ZENTRA_ANDROID_PREVIEW_KEYSTORE_PASSWORD",
            "--out", str(target), str(aligned))
        verification = subprocess.check_output([str(build_tools / "apksigner"), "verify", "--print-certs", str(target)], text=True)
        if f"Signer #1 certificate SHA-256 digest: {pin}" not in verification:
            raise SystemExit("Signed APK certificate differs from the preview identity")
        run(str(build_tools / "zipalign"), "-c", "-P", "16", "4", str(target))
        reports.append({"name": target.name, "bytes": target.stat().st_size,
                        "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                        "certificateSha256": pin, "package": manifest.splitlines()[0]})
        print(f"{source.name}: {source.stat().st_size} -> {target.stat().st_size} bytes", flush=True)
    (output / "signing-report.json").write_text(json.dumps(reports, indent=2) + "\n")
