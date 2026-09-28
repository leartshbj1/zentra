"""Negative cases for release identity and payload preservation (no private key)."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess
import zipfile
import xml.etree.ElementTree as ET
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('preview_check', Path(__file__).with_name('verify-android-preview.py'))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)
PIN = 'ab' * 32
VERIFIED = ('Verified using v2 scheme (APK Signature Scheme v2): true\n'
            'Number of signers: 1\nSigner #1 certificate SHA-256 digest: ' + PIN + '\n')


class PreviewVerification(unittest.TestCase):
    def test_rejects_wrong_or_multiple_identities_and_no_v2(self):
        check.check_signature_output(VERIFIED, PIN)
        cases = [VERIFIED.replace(PIN, 'cd' * 32), VERIFIED.replace(': true', ': false'),
                 VERIFIED.replace('signers: 1', 'signers: 2'),
                 VERIFIED + 'Signer #2 certificate SHA-256 digest: ' + PIN + '\n', '']
        for output in cases:
            with self.subTest(output=output), self.assertRaises(ValueError):
                check.check_signature_output(output, PIN)

    def test_signature_metadata_may_be_added_but_not_application_data_changed(self):
        with tempfile.TemporaryDirectory() as folder:
            source, signed = [Path(folder) / name for name in ('source.apk', 'signed.apk')]
            entries = {'classes.dex': b'code', 'AndroidManifest.xml': b'manifest',
                       'assets/logo.png': b'brand', 'META-INF/androidx.version': b'1'}
            with zipfile.ZipFile(source, 'w') as archive:
                for name, data in entries.items():
                    archive.writestr(name, data)
            signature = {'META-INF/MANIFEST.MF': b'mf', 'META-INF/SIGNER.SF': b'sf', 'META-INF/SIGNER.RSA': b'cert'}
            cases = [{**entries, **signature}, {**entries, 'classes.dex': b'changed'},
                     {**entries, 'META-INF/androidx.version': b'2'}, {**entries, 'assets/new.js': b'code'},
                     {name: value for name, value in entries.items() if name != 'assets/logo.png'}]
            for index, contents in enumerate(cases):
                with zipfile.ZipFile(signed, 'w') as archive:
                    for name, data in contents.items():
                        archive.writestr(name, data)
                if index == 0:
                    self.assertEqual(check.compare_payload(source, signed), len(entries))
                else:
                    with self.subTest(index=index), self.assertRaisesRegex(ValueError, 'payload'):
                        check.compare_payload(source, signed)

    def test_emulator_snapshot_never_reuses_an_old_ui_dump(self):
        module_spec = importlib.util.spec_from_file_location('candidate_smoke', Path(__file__).with_name('smoke-android-release-candidate.py'))
        smoke = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(smoke)
        paths = []

        def fake_adb(*args, **kwargs):
            if args[:2] == ('shell', 'uiautomator'):
                paths.append(args[-1])
                return 'ERROR: could not get idle state.'
            if args[0] == 'exec-out':
                self.assertEqual(args[-1], paths[-1])
                raise subprocess.CalledProcessError(1, 'cat')
            raise AssertionError(args)

        with patch.object(smoke, 'adb', side_effect=fake_adb), patch.object(smoke.time, 'monotonic_ns', side_effect=[101, 102]):
            for _ in range(2):
                with self.assertRaises(subprocess.CalledProcessError):
                    smoke.snapshot('unavailable')
        self.assertEqual(len(set(paths)), 2)

    def test_emulator_rejects_hidden_controls_and_overlapping_header(self):
        module_spec = importlib.util.spec_from_file_location('candidate_layout', Path(__file__).with_name('smoke-android-release-candidate.py'))
        smoke = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(smoke)
        hidden = ET.fromstring('<hierarchy><node text="Start" bounds="[0,0][0,0]" enabled="true" clickable="true"/></hierarchy>')
        with patch.object(smoke, 'adb') as adb_call:
            self.assertFalse(smoke.tap(hidden, {'Start'}))
            adb_call.assert_not_called()
        markup = ('<hierarchy><node class="android.widget.Image" text="Zentra" bounds="[24,14][142,46]"/>'
                  '<node text="Langue de l’application" clickable="true" bounds="[117,{top}][194,{bottom}]"/>'
                  '<node text="Apparence" clickable="true" bounds="[196,{top}][296,{bottom}]"/></hierarchy>')
        with self.assertRaisesRegex(RuntimeError, 'overlaps'):
            smoke.check_account_header(ET.fromstring(markup.format(top=14, bottom=58)))
        self.assertTrue(smoke.check_account_header(ET.fromstring(markup.format(top=66, bottom=110)))['noOverlap'])

    def test_keyboard_guard_rejects_the_reproduced_occlusion(self):
        module_spec = importlib.util.spec_from_file_location('keyboard_smoke', Path(__file__).with_name('smoke-android-release-candidate.py'))
        smoke = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(smoke)
        markup = ('<hierarchy><node class="android.webkit.WebView" bounds="[0,24][320,{bottom}]"/>'
                  '<node class="android.widget.EditText" focused="true" bounds="[24,{top}][296,{end}]"/></hierarchy>')
        windows = 'InsetsSource: {28 mType=ime mFrame=[0,380][320,640] mVisible=true}'
        with self.assertRaisesRegex(RuntimeError, 'obscured'):
            smoke.check_keyboard_field(ET.fromstring(markup.format(bottom=640, top=584, end=637)), windows)
        good = ET.fromstring(markup.format(bottom=380, top=300, end=353))
        self.assertEqual(smoke.check_keyboard_field(good, windows)['keyboardTop'], 380)
        with self.assertRaisesRegex(RuntimeError, 'missing'):
            smoke.check_keyboard_field(good, windows.replace('mVisible=true', 'mVisible=false'))

    def test_native_theme_guard_checks_pixels_and_system_icons(self):
        module_spec = importlib.util.spec_from_file_location('theme_smoke', Path(__file__).with_name('smoke-android-release-candidate.py'))
        smoke = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(smoke)
        root = ET.fromstring('<hierarchy><node class="android.webkit.WebView" bounds="[0,24][320,616]"/></hierarchy>')
        window = '\n Window #7 MainActivity:\n package=ch.zentra.mobile appop=NONE\n isVisible=true\n'
        for dark, color in [(True, (20,20,22)), (False, (245,245,247))]:
            flags = '' if dark else ' apr=LIGHT_STATUS_BARS LIGHT_NAVIGATION_BARS\n'
            with patch.object(smoke, 'module', return_value=SimpleNamespace(pixels=lambda _: (320,640,bytes(color)*320*640))):
                self.assertEqual(smoke.check_native_bars(root, b'fixture', window+flags, dark)['dark'], dark)
                with self.assertRaisesRegex(RuntimeError, 'icon contrast'):
                    wrong_flags = ' apr=LIGHT_STATUS_BARS LIGHT_NAVIGATION_BARS\n' if dark else ''
                    smoke.check_native_bars(root, b'fixture', window+wrong_flags, dark)
        with patch.object(smoke, 'module', return_value=SimpleNamespace(pixels=lambda _: (320,640,bytes((255,255,255))*320*640))):
            with self.assertRaisesRegex(RuntimeError, 'does not match'):
                smoke.check_native_bars(root, b'fixture', window, True)


if __name__ == '__main__':
    unittest.main()
