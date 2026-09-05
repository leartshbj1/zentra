"""Initialize the old native profile for an exact-APK upgrade on a CI emulator.

Old UI readiness is deliberately not a prerequisite: an update must also recover
an initialized profile whose old UI stalled. The current UI, migration, identity
and fixture preservation remain mandatory in smoke-android-upgrade.py.
"""
import json
from pathlib import Path
import re
import subprocess
import time


def adb(*args):
    return subprocess.check_output(["adb", *args], timeout=45)


subprocess.run(["adb", "wait-for-device"], check=True, timeout=120)
assert adb("get-serialno").decode().strip().startswith("emulator-")
assert adb("shell", "getprop", "ro.kernel.qemu").strip() == b"1"
deadline = time.monotonic() + 180
while adb("shell", "getprop", "sys.boot_completed").strip() != b"1":
    assert time.monotonic() < deadline, "Emulator boot timed out"
    time.sleep(2)
import sys
apk = Path(sys.argv[1]).resolve(strict=True)
adb("install", str(apk))
package = "ch.zentra.mobile"
version = re.search(rb"versionCode=(\d+)", adb("shell", "dumpsys", "package", package))
assert version, "Previous installed version missing"
adb("shell", "am", "start", "-W", "-n", package + "/.MainActivity")
deadline = time.monotonic() + 75
while True:
    files = adb("shell", "run-as", package, "find", ".", "-maxdepth", "1", "-type", "f")
    if b"installation-identity.protected" in files and b"helvichantier.sqlite3" in files:
        break
    assert time.monotonic() < deadline, "Previous native profile did not initialize"
    time.sleep(2)
# Keep a screenshot of the old state without depending on old React readiness.
# smoke-android-upgrade.py stops the process before reading/checking the database.
out = Path("desktop/artifacts/android")
out.mkdir(parents=True, exist_ok=True)
(out / "previous-native-profile.png").write_bytes(adb("exec-out", "screencap", "-p"))
(out / "previous-native-profile.json").write_text(json.dumps({
    "versionCode": int(version[1]), "emulatorOnly": True,
    "nativeFilesPresent": True, "oldUiReadinessRequired": False,
}, indent=2) + "\n")
print("Previous native profile initialized; exact APK upgrade can now verify recovery.")
