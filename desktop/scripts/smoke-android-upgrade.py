"""Verify a same-certificate preview upgrade using only an isolated CI emulator.

The older APK is re-signed as a fixture. This does not imply that old published
APKs signed with a lost ephemeral key can be upgraded to the durable identity.
"""
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
import time

PACKAGE = "ch.zentra.mobile"
OUT = Path("desktop/artifacts/android")


def adb(*args):
    return subprocess.check_output(["adb", *args], timeout=45)


def private(*args):
    return adb("exec-out", "run-as", PACKAGE, *args)


def write_private(path, data):
    # exec-out is output-only and does not close a remote tee's input. Transfer
    # fixture bytes with adb push, then copy them as the application's UID.
    remote = "/data/local/tmp/zentra-upgrade-transfer"
    with tempfile.TemporaryDirectory(prefix="zentra-upgrade-transfer-") as folder:
        local = Path(folder) / "fixture"
        local.write_bytes(data)
        adb("push", str(local), remote)
        try:
            private("cp", remote, path)
        finally:
            adb("shell", "rm", "-f", remote)


def version():
    match = re.search(rb"versionCode=(\d+)", adb("shell", "dumpsys", "package", PACKAGE))
    assert match, "Installed versionCode missing"
    return int(match[1])


def snapshot(folder):
    path = folder / "helvichantier.sqlite3"
    path.write_bytes(private("cat", "./helvichantier.sqlite3"))
    if private("find", ".", "-maxdepth", "1", "-name", "helvichantier.sqlite3-wal").strip():
        # Read the WAL only after the process is stopped, so the pair is stable.
        path.with_name(path.name + "-wal").write_bytes(private("cat", "./helvichantier.sqlite3-wal"))
    return path


serial = adb("get-serialno").decode().strip()
assert serial.startswith("emulator-"), "Upgrade fixture is restricted to an emulator"
assert adb("shell", "getprop", "ro.kernel.qemu").strip() == b"1"
before_version = version()
adb("shell", "am", "force-stop", PACKAGE)
identity_before = private("cat", "./installation-identity.protected")
fixture = b"Zentra isolated Android upgrade file fixture\n"
write_private("./files/zentra-update-fixture.txt", fixture)
with tempfile.TemporaryDirectory(prefix="zentra-upgrade-") as temp:
    temp = Path(temp)
    before = temp / "before"
    before.mkdir()
    db = snapshot(before)
    with sqlite3.connect(db) as connection:
        before_schema = connection.execute("PRAGMA user_version").fetchone()[0]
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("INSERT INTO clients(id,name,created_at,updated_at) VALUES('qa-upgrade-client','Client de validation Android','2026-09-05','2026-09-05')")
        connection.execute("INSERT INTO projects(id,client_id,name,budget_cents,created_at,updated_at) VALUES('qa-upgrade-project','qa-upgrade-client','Projet conservé après mise à jour',123456,'2026-09-05','2026-09-05')")
        connection.commit()
        connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    # Only this owned emulator fixture is changed; no real device/profile is used.
    write_private("./helvichantier.sqlite3", db.read_bytes())
    private("rm", "-f", "./helvichantier.sqlite3-wal", "./helvichantier.sqlite3-shm")
    adb("install", "-r", str(Path(sys.argv[1]).resolve()))
    after_version = version()
    assert after_version > before_version, "Upgrade must increase versionCode"
    adb("logcat", "-c")
    adb("shell", "am", "start", "-W", "-n", PACKAGE + "/.MainActivity")
    for _ in range(20):
        adb("shell", "uiautomator", "dump", "--compressed", "/sdcard/zentra-upgrade.xml")
        ui = adb("exec-out", "cat", "/sdcard/zentra-upgrade.xml")
        if b"Restaurer une sauvegarde" in ui:
            break
        time.sleep(3)
    assert b"Restaurer une sauvegarde" in ui, "Welcome interface missing after upgrade"
    adb("shell", "pidof", PACKAGE)
    (OUT / "upgrade-ui.xml").write_bytes(ui)
    (OUT / "upgrade.png").write_bytes(adb("exec-out", "screencap", "-p"))
    runtime = adb("logcat", "-d", "-s", "AndroidRuntime:E")
    (OUT / "upgrade-runtime.log").write_bytes(runtime)
    assert b"FATAL EXCEPTION" not in runtime
    adb("shell", "am", "force-stop", PACKAGE)
    assert private("cat", "./installation-identity.protected") == identity_before
    assert private("cat", "./files/zentra-update-fixture.txt") == fixture
    after = temp / "after"
    after.mkdir()
    db_after = snapshot(after)
    with sqlite3.connect(db_after) as connection:
        after_schema = connection.execute("PRAGMA user_version").fetchone()[0]
        assert after_schema >= before_schema and after_schema >= 49
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        assert connection.execute("SELECT name FROM clients WHERE id='qa-upgrade-client'").fetchone() == ("Client de validation Android",)
        assert connection.execute("SELECT client_id,budget_cents FROM projects WHERE id='qa-upgrade-project'").fetchone() == ("qa-upgrade-client", 123456)
        assert connection.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN ('expense_refund_attachment_insert_guard','expense_refund_attachment_no_delete')").fetchone()[0] == 2
    report = {"fromVersionCode": before_version, "toVersionCode": after_version,
              "fromSchema": before_schema, "toSchema": after_schema, "integrity": "ok",
              "installationIdentityPreserved": True, "clientAndProjectPreserved": True,
              "fixtureFilePreserved": True, "refundAttachmentGuards": True,
              "previousApkResignedAsFixture": True, "publishedOldApkUpgradeProven": False,
              "fixtureSha256": hashlib.sha256(fixture).hexdigest()}
    (OUT / "upgrade-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)
