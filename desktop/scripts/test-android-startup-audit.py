"""Regression checks for stale accessibility snapshots; never contacts adb."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('startup_audit', Path(__file__).with_name('audit-android-startup.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class AccessibilitySnapshotTests(unittest.TestCase):
    def test_failed_inspection_never_accepts_an_old_welcome_snapshot(self):
        for failure in [subprocess.CalledProcessError(1, 'uiautomator'), subprocess.TimeoutExpired('uiautomator', 15)]:
            with self.subTest(failure=type(failure).__name__), tempfile.TemporaryDirectory() as folder:
                calls = []
                process_checks = 0

                def adb(*args, **kwargs):
                    nonlocal process_checks
                    calls.append(args)
                    if args[:2] == ('shell', 'pidof'):
                        process_checks += 1
                        return b'123' if process_checks == 1 else b''
                    if args[:2] == ('shell', 'uiautomator'):
                        raise failure
                    # Simulates the stale snapshot left by the preceding launch.
                    return b'Restaurer une sauvegarde'

                with patch.object(audit, 'adb', side_effect=adb), patch.object(audit.time, 'sleep'):
                    opened, _ = audit.wait_for_welcome(Path(folder))
                self.assertFalse(opened)
                self.assertFalse(any(call[0] == 'exec-out' for call in calls))

    def test_recovery_requires_a_successful_fresh_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            dump_paths = []

            def adb(*args, **kwargs):
                if args[:2] == ('shell', 'pidof'):
                    return b'123'
                if args[:2] == ('shell', 'uiautomator'):
                    dump_paths.append(args[-1])
                    if len(dump_paths) == 1:
                        raise subprocess.CalledProcessError(1, 'uiautomator')
                    return b'UI hierarchy dumped'
                self.assertEqual(args[-1], dump_paths[-1])
                return b'Restaurer une sauvegarde'

            with patch.object(audit, 'adb', side_effect=adb), patch.object(audit.time, 'sleep'), patch.object(audit.time, 'monotonic_ns', side_effect=[100, 200]):
                opened, _ = audit.wait_for_welcome(Path(folder))
            self.assertTrue(opened)
            self.assertEqual(len(set(dump_paths)), 2)


if __name__ == '__main__':
    unittest.main()
