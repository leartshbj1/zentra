"""Check an existing simulator archive on a disposable GitHub Actions Mac."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import sqlite3
import subprocess
import sys
import time
import zipfile

PACKAGE = "ch.zentra.mobile"


def run(*args):
    return subprocess.check_output(args, stderr=subprocess.STDOUT, timeout=180)


def main():
    assert sys.platform == "darwin", "This check requires macOS"
    assert os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("GITHUB_RUN_ID", "").isdigit(), "Only disposable GitHub Actions runners are allowed"
    archive = Path(sys.argv[1]).resolve()
    expected_sha = os.environ["ZENTRA_IOS_ARCHIVE_SHA256"].lower()
    expected_schema = int(re.search(r"pub const SCHEMA_VERSION: i64 = (\d+);", Path("desktop/src-tauri/src/schema.rs").read_text()).group(1))
    assert len(expected_sha) == 64 and hashlib.sha256(archive.read_bytes()).hexdigest() == expected_sha
    with zipfile.ZipFile(archive) as bundle:
        assert bundle.testzip() is None
        info = plistlib.loads(bundle.read("Zentra.app/Info.plist"))
        assert info["CFBundleIdentifier"] == PACKAGE
        assert info["CFBundleSupportedPlatforms"] == ["iPhoneSimulator"]
        assert info["CFBundleShortVersionString"] == json.loads(Path("desktop/package.json").read_text())["version"]
    output = Path("desktop/artifacts/ios-audit")
    output.mkdir(parents=True, exist_ok=True)
    unpacked = Path(os.environ["RUNNER_TEMP"]) / ("zentra-ios-audit-" + os.environ["GITHUB_RUN_ID"])
    assert not unpacked.exists(), "Audit extraction directory already exists"
    unpacked.mkdir()
    run("ditto", "-x", "-k", str(archive), str(unpacked))
    devices = json.loads(run("xcrun", "simctl", "list", "devices", "available", "--json"))
    device = next(device for group in devices["devices"].values() for device in group if device["name"].startswith("iPhone"))
    simulator = device["udid"]
    report = {"archiveSha256": expected_sha, "version": info["CFBundleShortVersionString"], "checks": [], "uiScreenshotsRequireReview": True}
    identity_before = None

    def inspect(phase):
        nonlocal identity_before
        launch = run("xcrun", "simctl", "launch", simulator, PACKAGE).decode().strip()
        pid = int(launch.rsplit(":", 1)[1].strip())
        container = Path(run("xcrun", "simctl", "get_app_container", simulator, PACKAGE, "data").decode().strip())
        deadline = time.monotonic() + 90
        while True:
            os.kill(pid, 0)
            databases = list(container.rglob("helvichantier.sqlite3"))
            identities = list(container.rglob("installation-identity.protected"))
            if len(databases) == len(identities) == 1:
                break
            assert time.monotonic() < deadline, "Protected identity or database missing"
            time.sleep(1)
        # Save the actual screen for review, then stop the process before reading
        # SQLite and its WAL. Merely finding a database is not a UI assertion.
        time.sleep(15)
        os.kill(pid, 0)
        run("xcrun", "simctl", "io", simulator, "screenshot", str(output / (phase + ".png")))
        run("xcrun", "simctl", "terminate", simulator, PACKAGE)
        identity = identities[0].read_bytes()
        assert identity, "Protected identity is empty"
        if identity_before is None:
            identity_before = identity
        assert identity == identity_before, "Protected identity changed on restart"
        with sqlite3.connect(databases[0].as_uri() + "?mode=ro", uri=True) as connection:
            schema = connection.execute("PRAGMA user_version").fetchone()[0]
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
            settings = connection.execute("SELECT COUNT(*) FROM settings").fetchone()[0]
            assert (schema, integrity, settings) == (expected_schema, "ok", 0)
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        report["checks"].append({"phase": phase, "processAliveBeforeCapture": True, "identityPreserved": True, "schema": schema, "integrity": integrity, "settings": settings, "screenshot": phase + ".png"})
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")

    try:
        if device["state"] != "Booted":
            run("xcrun", "simctl", "boot", simulator)
        run("xcrun", "simctl", "bootstatus", simulator, "-b")
        run("xcrun", "simctl", "install", simulator, str(unpacked / "Zentra.app"))
        inspect("cold")
        inspect("app-restart")
        run("xcrun", "simctl", "shutdown", simulator)
        run("xcrun", "simctl", "boot", simulator)
        run("xcrun", "simctl", "bootstatus", simulator, "-b")
        inspect("simulator-restart")
        report["nativeChecksPassed"] = True
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report))
    finally:
        subprocess.run(["xcrun", "simctl", "shutdown", simulator], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=False)


if __name__ == "__main__":
    main()
