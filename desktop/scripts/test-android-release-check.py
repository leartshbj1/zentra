"""Release rejection cases, without executing Android tools or touching a device."""
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('release_check', Path(__file__).with_name('check-android-release.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)
BADGING = "package: name='ch.zentra.mobile' versionCode='1090006' versionName='1.90.6'\nsdkVersion:'24'\ntargetSdkVersion:'36'\nnative-code: 'arm64-v8a'\n"
TREE = 'A: android:allowBackup(0x01010280)=(type 0x12)0x0\n'


def elf(alignment=16384, offset=0, virtual=0):
    data = bytearray(120)
    data[:6] = b'\x7fELF\x02\x01'
    struct.pack_into('<H', data, 18, 183)
    struct.pack_into('<Q', data, 32, 64)
    struct.pack_into('<HH', data, 54, 56, 1)
    struct.pack_into('<IIQQQQQQ', data, 64, 1, 5, offset, virtual, 0, 0, 0, alignment)
    return data


class AndroidReleaseChecks(unittest.TestCase):
    def test_accepts_release_metadata_but_does_not_assert_signing_or_installation(self):
        result = check.check_manifest(BADGING, TREE, '1.90.6')
        self.assertFalse(result['debuggable'])
        self.assertNotIn('signatureVerified', result)

    def test_rejects_each_unsafe_boolean_and_missing_backup_rule(self):
        cases = [('', ''), (BADGING, ''), (BADGING + 'application-debuggable\n', TREE)]
        for key in ['debuggable', 'testOnly', 'usesCleartextTraffic', 'allowBackup']:
            cases.append((BADGING, TREE + f'A: android:{key}(0x00000001)=(type 0x12)0xffffffff\n'))
        for badging, tree in cases:
            with self.subTest(badging=badging, tree=tree), self.assertRaises(ValueError):
                check.check_manifest(badging, tree, '1.90.6')

    def test_rejects_wrong_identity_version_architecture_and_sdk(self):
        for old, new in [('ch.zentra.mobile', 'com.example.test'), ('1.90.6', '1.90.5'),
                         ("'arm64-v8a'", "'arm64-v8a' 'x86_64'"), ("sdkVersion:'24'", "sdkVersion:'23'"),
                         ("targetSdkVersion:'36'", "targetSdkVersion:'34'"), ("versionCode='1090006'", "versionCode='0'")]:
            with self.subTest(old=old), self.assertRaises(ValueError):
                check.check_manifest(BADGING.replace(old, new), TREE, '1.90.6')

    def test_elf_rejects_small_alignment_misaligned_segments_and_truncation(self):
        self.assertEqual(check.check_elf(elf(), 'app.so'), 1)
        for data in [elf(4096), elf(16384, 4096), elf(24576), elf()[:80], b'not-elf']:
            with self.subTest(data=len(data)), self.assertRaises(ValueError):
                check.check_elf(data, 'app.so')

    def test_archive_requires_and_checks_every_native_library(self):
        with tempfile.TemporaryDirectory() as folder:
            apk = Path(folder) / 'candidate.apk'
            for entries in [{}, {'lib/x86_64/a.so': elf()}, {'lib/arm64-v8a/a.so': elf(), 'lib/arm64-v8a/b.so': elf(4096)}]:
                with zipfile.ZipFile(apk, 'w') as archive:
                    for name, data in entries.items():
                        archive.writestr(name, data)
                with self.assertRaises(ValueError):
                    check.check_archive(apk)
            with zipfile.ZipFile(apk, 'w') as archive:
                archive.writestr('lib/arm64-v8a/a.so', elf())
            self.assertEqual(len(check.check_archive(apk)), 1)


if __name__ == '__main__':
    unittest.main()
