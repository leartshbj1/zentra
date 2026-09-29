"""Offline checks: diagnostics must never retry or replace the native gesture."""
import ast
import json
from pathlib import Path
import re
import io
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET


class DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.out = Path(self.temp.name)
        self.calls = []
        self.ns = dict(OUT=self.out, json=json, re=re, subprocess=subprocess, time=time, sys=sys, INPUT_OBSERVATIONS={},
                       adb=self.adb, capture_screen=lambda label, **kw: self.calls.append(('screen', label)))
        source = Path(__file__).with_name('smoke-android-release-candidate.py')
        tree = ast.parse(source.read_text(encoding='utf-8'))
        selected = {'bounds', 'tap', 'diagnosed_tap', 'input_diagnostics', 'collect_final_logs', 'collect_input_observations', 'diagnostic_write', 'webview_bounds'}
        functions = ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in selected], type_ignores=[])
        exec(compile(functions, str(source), 'exec'), self.ns)

    def adb(self, *args, **kw):
        self.calls.append(args)
        return 'fixture observation'

    def root(self):
        return ET.fromstring('<hierarchy><node text="Commencer" clickable="true" enabled="true" bounds="[51,492][269,548]"/></hierarchy>')

    def taps(self):
        return [c for c in self.calls if c[:3] == ('shell', 'input', 'tap')]

    def test_exact_single_tap_with_no_added_adb_or_io_before_assertion(self):
        self.assertTrue(self.ns['tap'](self.root(), {'Commencer'}, diagnostic_label='start'))
        self.assertEqual(self.taps(), [('shell', 'input', 'tap', '160', '520')])
        self.assertEqual(self.calls, self.taps())
        self.assertEqual(list(self.out.iterdir()), [])
        self.ns['collect_input_observations']()
        proof = json.loads((self.out / 'start-input.json').read_text())
        self.assertTrue(proof['commandCompleted'])
        self.assertGreaterEqual(proof['commandDurationMs'], 0)
        self.assertEqual(proof['nativeTapAttempts'], 1)
        self.assertEqual(proof['beforeScreenshot'], '01-welcome.png')
        self.assertEqual(proof['destinationScreenshot'], '02-account.png')
        self.assertEqual(proof['afterRecipeScreenshot'], 'captured')
        self.assertGreater(self.calls.index(('screen', 'start-after-recipe')), self.calls.index(self.taps()[0]))
        self.assertEqual(len(list(self.out.glob('*.txt'))), 3)

    def test_input_failure_propagates_with_evidence_and_no_retry(self):
        def fails(*args, **kw):
            self.calls.append(args)
            if args[:3] == ('shell', 'input', 'tap'):
                raise subprocess.TimeoutExpired('adb', 45)
            return 'observed'
        self.ns['adb'] = fails
        with self.assertRaises(subprocess.TimeoutExpired):
            self.ns['tap'](self.root(), {'Commencer'}, diagnostic_label='start')
        self.assertEqual(len(self.taps()), 1)
        self.assertEqual(self.calls, self.taps())
        self.ns['collect_input_observations']()
        proof = json.loads((self.out / 'start-input.json').read_text())
        self.assertFalse(proof['commandCompleted'])
        self.assertEqual(proof['commandError'], 'TimeoutExpired')
        self.assertEqual(proof['afterRecipeScreenshot'], 'captured')

    def test_unreachable_control_stays_failure(self):
        root = self.root()
        root[0].set('bounds', '[0,0][0,0]')
        self.assertFalse(self.ns['tap'](root, {'Commencer'}, diagnostic_label='start'))
        self.assertEqual(self.calls, [])

    def test_diagnostic_failure_does_not_create_a_recovery_gesture(self):
        def fails(label, **kw):
            raise subprocess.TimeoutExpired('screencap', 10)
        self.ns['capture_screen'] = fails
        self.assertTrue(self.ns['tap'](self.root(), {'Commencer'}, diagnostic_label='start'))
        self.ns['collect_input_observations']()
        self.assertEqual(len(self.taps()), 1)
        proof = json.loads((self.out / 'start-input.json').read_text())
        self.assertEqual(proof['afterRecipeScreenshot'], 'TimeoutExpired')

    def test_final_crash_buffer_collected_even_if_runtime_collection_fails(self):
        def fails(*args, **kw):
            self.calls.append(args)
            if args == ('logcat', '-d'):
                raise subprocess.TimeoutExpired('logcat', 15)
            return 'crash fixture'
        self.ns['adb'] = fails
        self.ns['collect_final_logs']()
        self.assertEqual((self.out / 'runtime-collection-error.txt').read_text(), 'TimeoutExpired')
        self.assertEqual((self.out / 'crash.log').read_text(), 'crash fixture')

    def test_unwritable_diagnostics_do_not_mask_original_failure(self):
        def fails(*args, **kw):
            raise subprocess.TimeoutExpired('adb', 45)
        self.ns['adb'] = fails
        with patch.object(Path, 'write_text', side_effect=PermissionError('fixture')), patch('sys.stderr', io.StringIO()):
            with self.assertRaises(subprocess.TimeoutExpired):
                try:
                    self.ns['tap'](self.root(), {'Commencer'}, diagnostic_label='start')
                finally:
                    self.ns['collect_final_logs']()
                    self.ns['collect_input_observations']()

    def webviews(self, outer, inner):
        return ET.fromstring(f'<hierarchy><node class="android.widget.FrameLayout"><node class="android.webkit.WebView" bounds="{outer}"><node class="android.webkit.WebView" text="Zentra" bounds="{inner}"/></node></node></hierarchy>')

    def test_native_viewport_is_not_the_scrolled_accessibility_document(self):
        # Exact rectangles from recipe 183: the native viewport was restored,
        # but its nested document was scrolled/focused one pixel lower.
        before = self.webviews('[0,24][320,616]', '[0,24][320,616]')
        after = self.webviews('[0,24][320,616]', '[0,25][320,616]')
        self.assertEqual(self.ns['webview_bounds'](after), (0, 24, 320, 616))
        self.assertEqual(self.ns['webview_bounds'](before), self.ns['webview_bounds'](after))

    def test_real_native_reduction_is_still_detected(self):
        before = self.webviews('[0,24][320,616]', '[0,24][320,616]')
        keyboard = self.webviews('[0,24][320,381]', '[0,25][320,381]')
        self.assertNotEqual(self.ns['webview_bounds'](before), self.ns['webview_bounds'](keyboard))

    def test_multiple_native_webviews_are_ambiguous(self):
        root = ET.fromstring('<hierarchy><node class="android.webkit.WebView" bounds="[0,24][320,616]"/><node class="android.webkit.WebView" bounds="[0,24][320,616]"/></hierarchy>')
        with self.assertRaises(RuntimeError):
            self.ns['webview_bounds'](root)


if __name__ == '__main__':
    unittest.main()
