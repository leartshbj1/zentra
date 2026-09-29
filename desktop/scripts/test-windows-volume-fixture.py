"""Local-only schema/fixture tests. Reads only the explicitly marked synthetic schema."""
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('fixture', Path(__file__).with_name('windows-volume-fixture.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
spec = importlib.util.spec_from_file_location('launcher', Path(__file__).with_name('windows-package-volume.py'))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class FixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = os.environ.get('ZENTRA_VOLUME_TEST_SCHEMA')
        if not source:
            raise unittest.SkipTest('Set ZENTRA_VOLUME_TEST_SCHEMA to the known synthetic profile directory')
        cls.source = Path(source).resolve()
        marker = json.loads((cls.source.parent / 'fixture.json').read_text())
        if marker.get('synthetic') is not True or marker.get('accountOrLicenseAdded') is not False:
            raise ValueError('Refusing an unmarked schema source')
        with closing(fixture.readonly(cls.source)) as db:
            if db.execute('SELECT company_name FROM settings').fetchone()[0] != 'Atelier Recette 1905':
                raise ValueError('Unexpected synthetic schema source')
            cls.schema = db.execute('PRAGMA user_version').fetchone()[0]
            cls.ddl = [r[0] for r in db.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END,rowid")]

    def new_profile(self):
        temporary = tempfile.TemporaryDirectory(prefix='zentra-volume-1909-')
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        profile = root / 'profile'; profile.mkdir()
        with closing(sqlite3.connect(profile / 'helvichantier.sqlite3')) as db:
            for sql in self.ddl:
                db.execute(sql)
            db.execute(f'PRAGMA user_version={self.schema}')
            db.commit()
        fixture.write_json(root / 'volume-run.json', {'purpose': fixture.PURPOSE, 'synthetic': True,
                          'profile': str(profile), 'initializedByPackage': True, 'schema': self.schema,
                          'testOnlySchemaCopy': True})
        return profile

    def test_deterministic_full_volume_and_business_conservation(self):
        first, second = self.new_profile(), self.new_profile()
        for profile in [first, second]:
            result = fixture.seed(profile)
            self.assertEqual(result['counts']['invoices'], 5000)
            self.assertEqual(result['counts']['quotes'], 5000)
            self.assertEqual(result['counts']['invoice_items'], 40000)
            self.assertEqual(result['counts']['journal_lines'], 16666)
            self.assertEqual(result['counts']['attachments'], 3)
        before, after = fixture.snapshot(first), fixture.snapshot(second)
        self.assertTrue(fixture.unchanged(before, after))
        self.assertEqual(before['localTables']['license_state']['rows'], 0)
        with self.assertRaisesRegex(ValueError, 'Never reseed'):
            fixture.seed(first)

    def test_unmarked_or_nonempty_profiles_are_rejected_without_writes(self):
        profile = self.new_profile()
        marker = profile.parent / 'volume-run.json'
        saved = marker.read_text()
        marker.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'ownership marker'):
            fixture.seed(profile)
        marker.write_text(saved)
        with closing(sqlite3.connect(profile / 'helvichantier.sqlite3')) as db:
            db.create_function('zentra_company_write_allowed', 0, lambda: 1)
            db.execute("INSERT INTO settings(id,company_name,created_at,updated_at) VALUES(1,'Sentinel','x','x')")
            db.commit()
        with self.assertRaisesRegex(ValueError, 'populated profile: settings'):
            fixture.seed(profile)
        with closing(fixture.readonly(profile)) as db:
            self.assertEqual(db.execute('SELECT company_name FROM settings').fetchone()[0], 'Sentinel')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM invoices').fetchone()[0], 0)

    def test_expired_budget_is_rejected_before_mutation(self):
        profile = self.new_profile()
        with self.assertRaisesRegex(ValueError, 'deadline exceeded'):
            fixture.seed(profile, deadline=0)
        with closing(fixture.readonly(profile)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM settings').fetchone()[0], 0)


@unittest.skipUnless(os.name == 'nt', 'Windows process containment only')
class WindowsBoundsTests(unittest.TestCase):
    def test_job_close_terminates_owned_descendants(self):
        import ctypes
        from ctypes import wintypes
        with tempfile.TemporaryDirectory(prefix='zentra-volume-1909-watchdog-') as folder:
            root = Path(folder); entered = root / 'waiting'; child_pid = root / 'child'
            code = (f"import importlib.util,pathlib,subprocess,sys,time\n"
                    f"spec=importlib.util.spec_from_file_location('launcher',{str(Path(launcher.__file__).resolve())!r})\n"
                    'launcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(launcher)\n'
                    f'pathlib.Path({str(entered)!r}).write_text("waiting")\n'
                    'launcher.wait_for_start_gate(int(sys.argv[-1]),time.time()+10)\n'
                    "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'])\n"
                    f'pathlib.Path({str(child_pid)!r}).write_text(str(child.pid))\n'
                    'time.sleep(30)')
            gate = launcher.WorkerStartGate()
            proc = subprocess.Popen([sys.executable, '-c', code, str(int(gate.handle))],
                                    startupinfo=gate.startup_info(), close_fds=True)
            close_job = None
            try:
                end = time.monotonic() + 5
                while not entered.exists() and time.monotonic() < end: time.sleep(.01)
                self.assertTrue(entered.exists())
                time.sleep(.1)
                self.assertIsNone(proc.poll())
                self.assertFalse(child_pid.exists(), 'A descendant started before the barrier was released')
                close_job = launcher.owned_job(proc)
                gate.release()
                end = time.monotonic() + 5
                while not child_pid.exists() and time.monotonic() < end: time.sleep(.01)
                self.assertTrue(child_pid.exists())
                kernel = ctypes.WinDLL('kernel32', use_last_error=True)
                kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
                kernel.OpenProcess.restype = wintypes.HANDLE
                kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
                kernel.CloseHandle.argtypes = [wintypes.HANDLE]
                handle = kernel.OpenProcess(0x00100000, False, int(child_pid.read_text()))
                self.assertTrue(handle)
                try:
                    close_job(); close_job = None
                    self.assertEqual(kernel.WaitForSingleObject(handle, 2000), 0)
                    proc.wait(timeout=2)
                finally:
                    kernel.CloseHandle(handle)
            finally:
                gate.close()
                if close_job: close_job()
                if proc.poll() is None: proc.kill(); proc.wait(timeout=2)

    def test_attachment_failure_never_releases_the_worker(self):
        with tempfile.TemporaryDirectory(prefix='zentra-volume-1909-gate-') as folder:
            root = Path(folder); entered, ran = root / 'waiting', root / 'ran'
            code = (f"import importlib.util,pathlib,sys,time\n"
                    f"spec=importlib.util.spec_from_file_location('launcher',{str(Path(launcher.__file__).resolve())!r})\n"
                    'launcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(launcher)\n'
                    f'pathlib.Path({str(entered)!r}).write_text("waiting")\n'
                    'launcher.wait_for_start_gate(int(sys.argv[-1]),time.time()+10)\n'
                    f'pathlib.Path({str(ran)!r}).write_text("forbidden")\n')
            owned = []
            def reject_attachment(proc):
                owned.append(proc)
                end = time.monotonic() + 5
                while not entered.exists() and time.monotonic() < end: time.sleep(.01)
                self.assertTrue(entered.exists())
                self.assertFalse(ran.exists())
                raise OSError('Simulated Job Object attachment failure')
            with (root / 'child.log').open('wb') as log, patch.object(launcher, 'owned_job', side_effect=reject_attachment), patch.object(launcher.WorkerStartGate, 'release', autospec=True) as release:
                with self.assertRaisesRegex(OSError, 'attachment failure'):
                    launcher.launch_owned_worker([sys.executable, '-c', code], log)
                release.assert_not_called()
            self.assertFalse(ran.exists())
            self.assertIsNotNone(owned[0].poll())

    def test_gate_missing_failed_or_timed_out_never_starts_a_probe(self):
        for handle in [None, 0, -1]:
            with self.subTest(handle=handle), self.assertRaisesRegex(ValueError, 'Missing mandatory'):
                launcher.wait_for_start_gate(handle, time.time()+1)
        # A real unsignalled event reaches WAIT_TIMEOUT. The child-side function
        # closes its handle; clear the parent wrapper to avoid double close.
        gate = launcher.WorkerStartGate()
        try:
            with self.assertRaisesRegex(ValueError, 'not released'):
                launcher.wait_for_start_gate(int(gate.handle), time.time()+.03)
        finally:
            gate.handle = None
        with self.assertRaisesRegex(ValueError, 'not released'):
            launcher.wait_for_start_gate(0x12345678, time.time()+1)
        with tempfile.TemporaryDirectory(prefix='zentra-volume-1909-failure-') as folder:
            args = SimpleNamespace(worker_root=folder, output=folder, deadline_epoch_ms=int((time.time()+30)*1000),
                                   start_gate_handle=None, node='not-invoked')
            with patch.object(launcher, 'probe_node') as probe, patch.object(launcher, 'exact_package') as package:
                self.assertEqual(launcher.worker(args), 1)
                probe.assert_not_called(); package.assert_not_called()

    def test_release_failure_terminates_worker_inside_job(self):
        processes = []
        attach = launcher.owned_job
        def remember(proc):
            processes.append(proc)
            return attach(proc)
        with tempfile.TemporaryFile() as log, patch.object(launcher, 'owned_job', side_effect=remember), patch.object(launcher.WorkerStartGate, 'release', side_effect=OSError('SetEvent failed')):
            with self.assertRaisesRegex(OSError, 'SetEvent failed'):
                launcher.launch_owned_worker([sys.executable, '-c', 'import time; time.sleep(30)'], log)
        self.assertIsNotNone(processes[0].poll())

    def test_supervisor_reserves_cleanup_and_waits_before_final_result(self):
        with tempfile.TemporaryDirectory(prefix='zentra-volume-1909-deadline-') as folder:
            root, output = Path(folder) / 'worker', Path(folder) / 'proof'
            root.mkdir()
            events = []
            def wait(timeout):
                events.append(('wait', timeout))
                if len(events) == 1:
                    raise subprocess.TimeoutExpired('worker', timeout)
                self.assertFalse((output / 'result.json').exists())
                return 1
            proc = SimpleNamespace(wait=wait, poll=lambda: 1)
            def start(command, log):
                deadline = int(command[command.index('--deadline-epoch-ms') + 1])
                self.assertEqual(deadline, 1595000)
                return proc, lambda: events.append(('close-job', None))
            arguments = ['volume', '--source', 'a' * 40, '--schema', '60', '--output', str(output),
                         '--node', sys.executable, '--disposable-runner']
            with patch.object(sys, 'argv', arguments), patch.object(launcher.time, 'time', return_value=1000), patch.object(launcher.tempfile, 'mkdtemp', return_value=str(root)), patch.object(launcher, 'launch_owned_worker', side_effect=start), patch('builtins.print'):
                self.assertEqual(launcher.main(), 2)
            self.assertEqual(events, [('wait', 595), ('close-job', None), ('wait', 5)])
            result = json.loads((output / 'result.json').read_text())
            self.assertEqual(result['status'], 'not_measured')
            self.assertFalse(result['measured'])


class NodePreflightTests(unittest.TestCase):
    def test_actual_node_runtime_has_required_capabilities(self):
        node = os.environ.get('ZENTRA_VOLUME_TEST_NODE') or launcher.shutil.which('node')
        if not node: self.skipTest('Node is unavailable')
        result = launcher.probe_node(node, time.time()+5)
        self.assertGreaterEqual(int(result['version'].split('.')[0]), 22)
        self.assertTrue(result['WebSocket'] and result['fetch'] and result['abortTimeout'])

    def test_invalid_runtime_exit_output_version_capabilities_and_timeout_are_rejected(self):
        good = {'version':'24.19.0', 'WebSocket':True, 'fetch':True, 'abortTimeout':True}
        cases = [(0, 'not-json'), (0, '[]'), (1, json.dumps(good)),
                 (0, json.dumps({**good,'version':'20.20.0'})),
                 (0, json.dumps({**good,'version':22})),
                 *[(0,json.dumps({**good,key:False})) for key in ['WebSocket','fetch','abortTimeout']]]
        for code, output in cases:
            with self.subTest(code=code, output=output), patch.object(launcher.subprocess, 'run', return_value=SimpleNamespace(returncode=code,stdout=output)) as run:
                with self.assertRaises(ValueError): launcher.probe_node('fake-node', time.time()+30)
                self.assertLessEqual(run.call_args.kwargs['timeout'], 5)
        with patch.object(launcher.subprocess, 'run', side_effect=subprocess.TimeoutExpired('node', 5)):
            with self.assertRaises(subprocess.TimeoutExpired): launcher.probe_node('fake-node', time.time()+30)

    def test_runtime_rejection_precedes_all_other_processes_and_downloads(self):
        with tempfile.TemporaryDirectory(prefix='zentra-volume-1909-preflight-') as folder:
            args = SimpleNamespace(worker_root=folder, output=folder, deadline_epoch_ms=int((time.time()+30)*1000),
                                   start_gate_handle=123, node='old-node')
            events = []
            def reject(*args):
                events.append('probe')
                raise ValueError('Node version 22 or newer is required')
            with patch.object(launcher, 'wait_for_start_gate', side_effect=lambda *args: events.append('gate')), patch.object(launcher, 'probe_node', side_effect=reject), patch.object(launcher.subprocess, 'check_output') as tasklist, patch.object(launcher, 'exact_package') as package:
                self.assertEqual(launcher.worker(args), 1)
                self.assertEqual(events, ['gate', 'probe'])
                tasklist.assert_not_called(); package.assert_not_called()
            self.assertIn('Node version 22', json.loads((Path(folder)/'result.json').read_text())['error'])


if __name__ == '__main__':
    unittest.main()
