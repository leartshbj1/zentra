"""Strip native debug symbols from CI test APKs, realign, and sign with a test key.

Only debuggable APKs are accepted. Production/store signing is deliberately separate.
"""

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
    keystore = staging / "debug.keystore"
    # This ephemeral standard Android test key must never sign a store release.
    run("keytool", "-genkeypair", "-keystore", str(keystore), "-storepass", "android",
        "-keypass", "android", "-alias", "androiddebugkey", "-keyalg", "RSA",
        "-keysize", "2048", "-validity", "365", "-dname", "CN=Android Debug,O=Android,C=US")
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
        run(str(build_tools / "apksigner"), "sign", "--ks", str(keystore), "--ks-key-alias",
            "androiddebugkey", "--ks-pass", "pass:android", "--key-pass", "pass:android",
            "--out", str(target), str(aligned))
        run(str(build_tools / "apksigner"), "verify", str(target))
        run(str(build_tools / "zipalign"), "-c", "-P", "16", "4", str(target))
        print(f"{source.name}: {source.stat().st_size} -> {target.stat().st_size} bytes", flush=True)
