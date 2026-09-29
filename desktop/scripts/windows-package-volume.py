"""Measure an exact Windows package in a disposable runner; never a user profile.

No application code, build flags, credentials or CI configuration are changed.
The supervisor kills its entire Windows Job Object after at most ten minutes.
"""
import argparse
from contextlib import closing
import ctypes
from ctypes import wintypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


fixture = module('volume_fixture', 'windows-volume-fixture.py')
smoke = module('package_smoke', 'cloud-package-smoke.py')


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def remaining(deadline, cap):
    seconds = min(cap, deadline - time.time())
    fixture.require(seconds > 0, 'Global ten-minute deadline reached')
    return seconds


def probe_node(executable, deadline):
    """Check the actual runtime, locally, before fetching or installing anything."""
    script = """console.log(JSON.stringify({version:process.versions.node,
      WebSocket:typeof globalThis.WebSocket==='function',
      fetch:typeof globalThis.fetch==='function',
      abortTimeout:typeof globalThis.AbortSignal?.timeout==='function'}));"""
    completed = subprocess.run([executable, '--input-type=module', '--eval', script],
        capture_output=True, text=True, timeout=remaining(deadline, 5), check=False,
        creationflags=subprocess.CREATE_NO_WINDOW)
    fixture.require(completed.returncode == 0, 'Node capability probe failed')
    try:
        info = json.loads(completed.stdout)
    except (json.JSONDecodeError, TypeError) as error:
        raise ValueError('Node capability probe did not return valid JSON') from error
    fixture.require(isinstance(info, dict), 'Node capability probe returned an invalid shape')
    version = info.get('version')
    match = re.fullmatch(r'(\d+)\.\d+\.\d+(?:[-+].*)?', version) if isinstance(version, str) else None
    fixture.require(match is not None and int(match.group(1)) >= 22, 'Node version 22 or newer is required')
    fixture.require(all(info.get(name) is True for name in ('WebSocket', 'fetch', 'abortTimeout')),
                    'Node lacks WebSocket, fetch or AbortSignal.timeout')
    return {name: info[name] for name in ('version', 'WebSocket', 'fetch', 'abortTimeout')}


def wait_for_start_gate(handle, deadline):
    """No worker subprocess/network activity is permitted before this succeeds."""
    fixture.require(isinstance(handle, int) and handle > 0, 'Missing mandatory worker start gate')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    try:
        timeout = max(1, int(remaining(deadline, 15) * 1000))
        outcome = kernel.WaitForSingleObject(wintypes.HANDLE(handle), timeout)
        # WAIT_TIMEOUT, WAIT_FAILED and every other value fail closed.
        fixture.require(outcome == 0, 'Worker start gate was not released by its supervisor')
    finally:
        # Do not allow the barrier handle to leak into the worker's descendants.
        kernel.CloseHandle(wintypes.HANDLE(handle))


class WorkerStartGate:
    """An anonymous, initially closed event inherited only by the worker."""
    def __init__(self):
        class SecurityAttributes(ctypes.Structure):
            _fields_ = [('length', wintypes.DWORD), ('descriptor', ctypes.c_void_p), ('inherit', wintypes.BOOL)]
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.CreateEventW.argtypes = [ctypes.POINTER(SecurityAttributes), wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
        self.kernel.CreateEventW.restype = wintypes.HANDLE
        self.kernel.SetEvent.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        attributes = SecurityAttributes(ctypes.sizeof(SecurityAttributes), None, True)
        self.handle = self.kernel.CreateEventW(ctypes.byref(attributes), True, False, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())

    def startup_info(self):
        info = subprocess.STARTUPINFO()
        info.lpAttributeList = {'handle_list': [int(self.handle)]}
        return info

    def release(self):
        if not self.kernel.SetEvent(self.handle):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def launch_owned_worker(command, log, job_layout='strict'):
    gate = WorkerStartGate()
    proc, close_job = None, None
    try:
        proc = subprocess.Popen([*command, '--start-gate-handle', str(int(gate.handle))],
            stdout=log, stderr=log, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
            startupinfo=gate.startup_info(), close_fds=True)
        close_job = owned_job(proc) if job_layout == 'strict' else owned_job(proc, job_layout)
        # This is the only release site, after successful job creation AND attachment.
        gate.release()
        return proc, close_job
    except BaseException:
        if close_job:
            close_job()
        elif proc is not None and proc.poll() is None:
            # Its gate is still closed: this worker cannot have any descendants.
            proc.kill()
        if proc is not None:
            proc.wait(timeout=5)
        raise
    finally:
        gate.close()


def private_environment(profile, webview, port):
    env = {**os.environ, 'HELVICHANTIER_DATA_DIR': str(profile),
           'WEBVIEW2_USER_DATA_FOLDER': str(webview),
           'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS':
               f'--remote-debugging-address=127.0.0.1 --remote-debugging-port={port} '
               '--proxy-server=127.0.0.1:9 --proxy-bypass-list=tauri.localhost;ipc.localhost;asset.localhost',
           'HTTP_PROXY': 'http://127.0.0.1:9', 'HTTPS_PROXY': 'http://127.0.0.1:9',
           'ALL_PROXY': 'http://127.0.0.1:9', 'NO_PROXY': '127.0.0.1,localhost,tauri.localhost,ipc.localhost,asset.localhost'}
    # Also cover clients which inspect the lower-case forms. Nothing listens on
    # port 9 in this isolated runner; no credential or cloud session is installed.
    for name in ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']:
        env[name.lower()] = env[name]
    return env


def current_token_evidence():
    """Read only privilege metadata; never export a SID, user name or token."""
    class SidAndAttributes(ctypes.Structure):
        _fields_ = [('sid', ctypes.c_void_p), ('attributes', wintypes.DWORD)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    advapi.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                          wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    advapi.IsValidSid.argtypes = [ctypes.c_void_p]
    advapi.GetSidSubAuthorityCount.argtypes = [ctypes.c_void_p]
    advapi.GetSidSubAuthorityCount.restype = ctypes.POINTER(ctypes.c_ubyte)
    advapi.GetSidSubAuthority.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    advapi.GetSidSubAuthority.restype = ctypes.POINTER(wintypes.DWORD)
    token, size, elevated = wintypes.HANDLE(), wintypes.DWORD(), wintypes.DWORD()
    if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008, ctypes.byref(token)):  # TOKEN_QUERY
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        if not advapi.GetTokenInformation(token, 20, ctypes.byref(elevated), ctypes.sizeof(elevated), ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        advapi.GetTokenInformation(token, 25, None, 0, ctypes.byref(size))
        fixture.require(0 < size.value <= 65536, 'Unexpected integrity-token size')
        buffer = ctypes.create_string_buffer(size.value)
        if not advapi.GetTokenInformation(token, 25, buffer, size, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        sid = ctypes.cast(buffer, ctypes.POINTER(SidAndAttributes)).contents.sid
        fixture.require(advapi.IsValidSid(sid), 'Invalid integrity SID')
        count = advapi.GetSidSubAuthorityCount(sid)[0]
        fixture.require(count > 0, 'Integrity SID has no authority')
        rid = advapi.GetSidSubAuthority(sid, count - 1)[0]
        level = 'system' if rid >= 0x4000 else 'high' if rid >= 0x3000 else 'medium' if rid >= 0x2000 else 'low' if rid >= 0x1000 else 'untrusted'
        return {'elevated': bool(elevated.value), 'integrityRid': rid, 'integrity': level}
    finally:
        kernel.CloseHandle(token)


def supported_volume_host(evidence):
    rid = evidence.get('integrityRid')
    return evidence.get('elevated') is False and type(rid) is int and 0x2000 <= rid < 0x3000


def stop_tree(proc):
    if proc.poll() is None:
        subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8, check=False)
        proc.wait(timeout=8)


def wait_for_initialization(profile, expected_schema, proc, deadline, evidence):
    """Preserve the last failed check without changing the 60-second wait."""
    started = time.time()
    end = min(deadline, started + 60)
    database = profile / 'helvichantier.sqlite3'
    evidence.update(expectedSchema=expected_schema, sqliteVersion=sqlite3.sqlite_version,
                    databaseAccess='existing-file-only, query_only=ON', attempts=0,
                    observedSchema=None, integrity=None, foreignKeys=None, lastSqliteError=None)
    try:
        while time.time() < end:
            evidence['processExit'] = proc.poll()
            fixture.require(evidence['processExit'] is None,
                            'Packaged app exited during empty-profile initialization')
            evidence['attempts'] += 1
            evidence['databaseExists'] = database.is_file()
            try:
                with closing(sqlite3.connect(database.as_uri() + '?mode=rw', uri=True, timeout=.2)) as db:
                    db.execute('PRAGMA query_only=ON')
                    evidence['observedSchema'] = db.execute('PRAGMA user_version').fetchone()[0]
                    # Do not short-circuit diagnostics merely because the schema differs.
                    evidence['integrity'] = str(db.execute('PRAGMA integrity_check').fetchone()[0])[:512]
                    violations = db.execute('PRAGMA foreign_key_check').fetchmany(17)
                    evidence['foreignKeys'] = {'observedViolations': min(len(violations), 16),
                                               'truncated': len(violations) > 16}
                failed = []
                if evidence['observedSchema'] != expected_schema: failed.append('schema')
                if evidence['integrity'] != 'ok': failed.append('integrity')
                if violations: failed.append('foreign_keys')
                evidence['lastFailedChecks'] = failed
                if not failed:
                    evidence['validated'] = True
                    return evidence['observedSchema']
            except sqlite3.Error as error:
                evidence['lastFailedChecks'] = ['sqlite_error']
                evidence['lastSqliteError'] = {
                    'type': type(error).__name__, 'message': str(error)[:1024],
                    'code': getattr(error, 'sqlite_errorcode', None),
                    'name': getattr(error, 'sqlite_errorname', None), 'attempt': evidence['attempts']}
            time.sleep(min(.2, max(0, end - time.time())))
        raise ValueError('Exact package did not initialize the expected schema')
    finally:
        evidence['elapsedMs'] = round((time.time() - started) * 1000)


def profile_file_diagnostics(profile, deadline):
    """Metadata only, at most 64 entries/three levels; never follow reparse points."""
    profile = Path(profile)
    fixture.require(profile.is_absolute() and profile.name == 'profile' and
                    profile.parent.name.startswith('zentra-volume-1909-'), 'Unexpected diagnostic profile')
    for path in (profile, *profile.parents):
        info = path.lstat()
        fixture.require(not stat.S_ISLNK(info.st_mode) and not
                        (getattr(info, 'st_file_attributes', 0) & 0x400), 'Diagnostic reparse point forbidden')
    fixture.require(profile.resolve() == profile, 'Diagnostic profile must be canonical')
    entries, pending, truncated = [], [(profile, 0)], False
    while pending:
        folder, depth = pending.pop()
        with os.scandir(folder) as listing:
            for item in listing:
                if len(entries) >= 64 or time.time() >= deadline:
                    return {'entries': entries, 'truncated': True}
                info = item.stat(follow_symlinks=False)
                linked = stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)
                directory = stat.S_ISDIR(info.st_mode)
                entries.append({'path': str(Path(item.path).relative_to(profile))[:256],
                                'kind': 'reparse' if linked else 'directory' if directory else 'file',
                                'bytes': info.st_size if not directory and not linked else None})
                if directory and not linked:
                    if depth < 2: pending.append((Path(item.path), depth + 1))
                    else: truncated = True
    return {'entries': entries, 'truncated': truncated}


def owned_process_diagnostics(pid, deadline):
    """Export only the selected process tree; no command lines, titles or environment."""
    class ProcessEntry(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('usage', wintypes.DWORD), ('pid', wintypes.DWORD),
                    ('heap', ctypes.c_size_t), ('module', wintypes.DWORD), ('threads', wintypes.DWORD),
                    ('parent', wintypes.DWORD), ('priority', wintypes.LONG), ('flags', wintypes.DWORD),
                    ('image', wintypes.WCHAR * 260)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateToolhelp32Snapshot(2, 0)  # TH32CS_SNAPPROCESS
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    entries, truncated = [], False
    try:
        entry = ProcessEntry(); entry.size = ctypes.sizeof(ProcessEntry)
        available = kernel.Process32FirstW(handle, ctypes.byref(entry))
        if not available: raise ctypes.WinError(ctypes.get_last_error())
        while available:
            if len(entries) >= 4096 or time.time() >= deadline:
                truncated = True
                break
            entries.append({'pid': entry.pid, 'parentPid': entry.parent, 'image': entry.image})
            available = kernel.Process32NextW(handle, ctypes.byref(entry))
            if not available:
                error = ctypes.get_last_error()
                if error != 18:  # ERROR_NO_MORE_FILES is the only normal end.
                    raise ctypes.WinError(error)
    finally:
        kernel.CloseHandle(handle)
    selected, owned = [], {pid}
    for _ in range(32):
        children = [row for row in entries if row['parentPid'] in owned and row['pid'] not in owned]
        if not children: break
        for child in children:
            if len(selected) >= 128:
                return {'descendants': selected, 'truncated': True}
            selected.append(child); owned.add(child['pid'])
    else: truncated = True
    return {'descendants': selected, 'truncated': truncated,
            'webview2Count': sum(row['image'].lower() == 'msedgewebview2.exe' for row in selected)}


def initialization_diagnostics(profile, proc, deadline, evidence, error):
    """Best-effort evidence within two seconds/the existing global budget."""
    evidence['failure'] = f'{type(error).__name__}: {error}'[:1024]
    end = min(deadline, time.time() + 2)
    checks = [('process', lambda: {'pid': proc.pid, 'exitCode': proc.poll()}),
              ('profileFiles', lambda: profile_file_diagnostics(profile, end)),
              ('processTree', lambda: owned_process_diagnostics(proc.pid, end))]
    for name, collect in checks:
        if time.time() >= end:
            evidence[name] = {'unavailable': 'diagnostic budget exhausted'}
            continue
        try:
            evidence[name] = collect()
        except Exception as diagnostic_error:
            evidence[name] = {'unavailable': f'{type(diagnostic_error).__name__}: {diagnostic_error}'[:512]}


def save_initialization_evidence(out, evidence):
    try:
        fixture.write_json(out / 'initialization.json', evidence)
    except Exception as error:
        # A failed diagnostic write must never hide the original startup failure.
        evidence['diagnosticWriteError'] = f'{type(error).__name__}: {error}'[:512]


def exact_package(args, root, deadline):
    # Reuse the unchanged smoke downloader's HTTPS/CI-host/size restrictions.
    # The NSIS byte-for-byte check is deliberately the same as the ordinary smoke.
    api = f'https://circleci.com/api/v1.1/project/github/leartshbj1/zentra/{args.job}'
    build = json.loads(smoke.fetch(api))
    fixture.require(build['status'] == 'success' and build['vcs_revision'] == args.source,
                    'Build is not successful at the requested source revision')
    rows = json.loads(smoke.fetch(api + '/artifacts'))
    records = {}
    for item in rows:
        name = Path(item['path']).name
        fixture.require(name not in records, 'Ambiguous artifact filename')
        records[name] = item
    def download(name):
        remaining(deadline, 180)
        target = root / name
        target.write_bytes(smoke.fetch(records[name]['url']))
        return target
    proof = json.loads(download('provenance.json').read_text(encoding='utf-8-sig'))
    fixture.require(proof['source'] == args.source and proof['version'] == '1.90.9', 'Wrong release provenance')
    fixture.require(proof['identifier'] == 'ch.helvichantier.desktop' and proof['target'] == 'x86_64-pc-windows-msvc', 'Wrong package target')
    fixture.require(all(proof.get(k) is True for k in ['companyTestsPassed', 'accountTestsPassed', 'interfaceWorkspaceTestsPassed']), 'Missing release regression proofs')
    name = 'Zentra_1.90.9_x64-setup.exe'
    hashes = {f['name']: f for f in proof['files']}
    fixture.require(len(hashes) == len(proof['files']) and set(hashes) == {'Zentra.exe', name}, 'Wrong build inventory')
    installer, loose = download(name), download('Zentra.exe')
    for path in [installer, loose]:
        fixture.require(path.stat().st_size == hashes[path.name]['size'] and sha(path) == hashes[path.name]['sha256'].lower(), 'Artifact hash/size mismatch')
    original = loose.read_bytes()
    marker = b'__TAURI_BUNDLE_TYPE_VAR_UNK'
    fixture.require(original.count(marker) == 1, 'Unexpected Tauri bundle marker')
    expected = hashlib.sha256(original.replace(marker, b'__TAURI_BUNDLE_TYPE_VAR_NSS', 1)).hexdigest()
    install_dir = root / 'application'
    subprocess.run([str(installer), '/S', '/D=' + str(install_dir)], check=True,
                   timeout=remaining(deadline, 180), creationflags=subprocess.CREATE_NO_WINDOW)
    exe = install_dir / 'Zentra.exe'
    extraction_end = min(deadline, time.time() + 30)
    while time.time() < extraction_end:
        if exe.is_file() and sha(exe) == expected:
            break
        time.sleep(.2)
    fixture.require(exe.is_file() and sha(exe) == expected, 'Installed executable differs from verified NSIS payload')
    return exe, {'version': '1.90.9', 'source': args.source, 'buildJob': args.job,
                 'installedExecutableSha256': expected, 'rawExecutableSha256': hashes['Zentra.exe']['sha256'].lower(),
                 'nsisBundleMarkerVerified': True, 'exactPackageVerified': True}


def worker(args):
    root, out = Path(args.worker_root), Path(args.output)
    profile, webview = root / 'profile', root / 'webview'
    result = {'scope': 'One exact Windows package and one synthetic local company; no production-capacity claim',
              'measured': False, 'ipcMeasured': False, 'uiMeasured': False, 'status': 'failed', 'profile': str(profile),
              'verifierFilesSha256': {name: sha(Path(__file__).with_name(name)) for name in
                  ['windows-package-volume.py', 'windows-volume-fixture.py', 'windows-volume-collector.mjs', 'cloud-package-smoke.py']}}
    deadline = args.deadline_epoch_ms / 1000
    try:
        wait_for_start_gate(args.start_gate_handle, deadline)
        result['containment'] = {'layout': getattr(args, 'job_layout', 'strict'), 'startupGatePassed': True}
        result['nodeRuntime'] = probe_node(args.node, deadline)
        try:
            result['hostToken'] = current_token_evidence()
        except Exception as token_error:
            result['hostToken'] = {'unavailable': f'{type(token_error).__name__}: {token_error}'[:512]}
        if not supported_volume_host(result['hostToken']):
            result.update(status='not_measured', reason='A verified non-elevated medium-integrity host is required; '
                          'WebView2 ignores WEBVIEW2_* environment overrides when elevated')
            fixture.write_json(out / 'result.json', result)
            return 2
        existing = subprocess.check_output(['tasklist', '/FI', 'IMAGENAME eq Zentra.exe', '/FO', 'CSV'],
                                           timeout=remaining(deadline, 5), text=True)
        fixture.require('"zentra.exe"' not in existing.lower(), 'Another Zentra instance exists; use a disposable runner')
        # Nothing must listen at the deliberately closed outbound proxy endpoint.
        with socket.socket() as proxy:
            proxy.settimeout(.2)
            fixture.require(proxy.connect_ex(('127.0.0.1', 9)) != 0, 'The offline proxy port is occupied')
        exe, package = exact_package(args, root, deadline)
        result['package'] = package
        profile.mkdir(); webview.mkdir()
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0)); port = reservation.getsockname()[1]
        env = private_environment(profile, webview, port)
        # The exact application, not Python, creates the original empty database.
        log = (out / 'package-startup.log').open('ab')
        try:
            proc = subprocess.Popen([str(exe)], env=env, stdout=log, stderr=log)
            initialization = result['initialization'] = {}
            try:
                schema = wait_for_initialization(profile, args.schema, proc, deadline, initialization)
                # Match the ordinary smoke's post-initialization survival check.
                time.sleep(remaining(deadline, 5))
                fixture.require(proc.poll() is None, 'Packaged app exited after database initialization')
            except Exception as error:
                initialization_diagnostics(profile, proc, deadline, initialization, error)
                raise
            finally:
                save_initialization_evidence(out, initialization)
                stop_tree(proc)
            marker = {'purpose': fixture.PURPOSE, 'synthetic': True, 'profile': str(profile),
                      'initializedByPackage': True, 'schema': schema, 'applicationSha256': package['installedExecutableSha256']}
            fixture.write_json(root / 'volume-run.json', marker)
            result['fixture'] = fixture.seed(profile, deadline=time.monotonic() + remaining(deadline, 600))
            fixture.write_json(out / 'fixture.json', result['fixture'])
            before = fixture.snapshot(profile)
            fixture.write_json(out / 'before.json', before)
            started = time.time()
            proc = subprocess.Popen([str(exe)], env=env, stdout=log, stderr=log)
            try:
                collector = Path(__file__).with_name('windows-volume-collector.mjs')
                completed = subprocess.run([args.node, str(collector), '--endpoint', f'http://127.0.0.1:{port}',
                    '--profile', str(profile), '--version', '1.90.9', '--output', str(out / 'measurements.json'),
                    '--deadline-epoch-ms', str(args.deadline_epoch_ms), '--started-epoch-ms', str(round(started * 1000))],
                    env=env, stdout=log, stderr=log, timeout=remaining(deadline, 600), check=False)
                result['collectorExit'] = completed.returncode
            finally:
                stop_tree(proc)
        finally:
            log.close()
        after = fixture.snapshot(profile)
        fixture.write_json(out / 'after.json', after)
        result['businessDataUnchanged'] = fixture.unchanged(before, after)
        fixture.require(result['businessDataUnchanged'], 'Business tables or attachments changed during measurement')
        fixture.require(sha(exe) == package['installedExecutableSha256'], 'Installed executable changed')
        if (out / 'measurements.json').is_file():
            measurement = json.loads((out / 'measurements.json').read_text(encoding='utf-8'))
            result['measured'] = measurement.get('measured') is True
            result['ipcMeasured'] = measurement.get('ipcMeasured') is True
            result['uiMeasured'] = measurement.get('uiMeasured') is True
            result['status'] = measurement.get('status', 'failed')
        fixture.require(result['collectorExit'] in (0, 2), 'Collector failed; consult measurements.json')
        fixture.require(result['status'] in ('passed', 'partial', 'not_measured'), 'Unknown collector outcome')
        if result['status'] == 'passed':
            fixture.require(result['collectorExit'] == 0 and result['measured'] and result['ipcMeasured'] and result['uiMeasured'],
                            'A complete result requires both native IPC and UI measurements')
    except Exception as error:
        result.update(status='failed', measured=False, error=f'{type(error).__name__}: {error}')
    fixture.write_json(out / 'result.json', result)
    return 0 if result['measured'] and result['status'] == 'passed' else 2 if result['status'] in ('not_measured', 'partial') else 1


def owned_job(proc, job_layout='strict'):
    """Kill every owned descendant on timeout or supervisor failure (Windows)."""
    fixture.require(job_layout in ('strict', 'nested-breakaway'), 'Unknown Job Object layout')
    class Basic(ctypes.Structure):
        _fields_ = [('processTime', ctypes.c_int64), ('jobTime', ctypes.c_int64), ('flags', wintypes.DWORD),
                    ('minWorkingSet', ctypes.c_size_t), ('maxWorkingSet', ctypes.c_size_t),
                    ('activeLimit', wintypes.DWORD), ('affinity', ctypes.c_size_t),
                    ('priority', wintypes.DWORD), ('scheduling', wintypes.DWORD)]
    class Extended(ctypes.Structure):
        _fields_ = [('basic', Basic), ('io', ctypes.c_uint64 * 6), ('processMemory', ctypes.c_size_t),
                    ('jobMemory', ctypes.c_size_t), ('peakProcess', ctypes.c_size_t), ('peakJob', ctypes.c_size_t)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handles, closed = [], False

    def close_job():
        nonlocal closed
        if not closed:
            closed = True
            # Close the non-breakaway outer Job first, including escaped inner children.
            for handle in handles: kernel.CloseHandle(handle)

    def membership(process_handle):
        fixture.require(not closed, 'Job handles have already been closed')
        answer = {'outer': None, 'inner': None}
        for name, handle in zip(('outer', 'inner'), handles):
            included = wintypes.BOOL()
            if not kernel.IsProcessInJob(wintypes.HANDLE(int(process_handle)), handle, ctypes.byref(included)):
                raise ctypes.WinError(ctypes.get_last_error())
            answer[name] = bool(included.value)
        return answer

    try:
        # The outer Job never permits any form of breakaway. The optional inner
        # Job permits only an explicit CREATE_BREAKAWAY_FROM_JOB request, which
        # stops at that non-breakaway outer ancestor (Windows nested-job rules).
        flags = [0x2000] + ([0x0800] if job_layout == 'nested-breakaway' else [])
        for limit_flags in flags:
            handle = kernel.CreateJobObjectW(None, None)
            if not handle: raise ctypes.WinError(ctypes.get_last_error())
            handles.append(handle)
            limits = Extended(); limits.basic.flags = limit_flags
            if not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
                raise ctypes.WinError(ctypes.get_last_error())
        for handle in handles:
            if not kernel.AssignProcessToJobObject(handle, wintypes.HANDLE(int(proc._handle))):
                raise ctypes.WinError(ctypes.get_last_error())
        worker_membership = membership(proc._handle)
        fixture.require(worker_membership['outer'] and
                        (job_layout == 'strict' or worker_membership['inner']), 'Worker escaped its required Jobs')
        close_job.membership = membership
        close_job.evidence = {'layout': job_layout, 'outerLimitFlags': flags[0],
                              'innerLimitFlags': flags[1] if len(flags) == 2 else None,
                              'workerMembership': worker_membership}
        return close_job
    except BaseException:
        close_job()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job', type=int, default=181)
    parser.add_argument('--source', required=True)
    parser.add_argument('--schema', type=int, required=True, help='Schema version from this exact release source')
    parser.add_argument('--output', required=True, help='New directory for JSON/logs/screenshots, never SQLite')
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--job-layout', choices=('strict', 'nested-breakaway'), default='strict',
                        help='Explicit containment experiment; the outer Job always refuses breakaway')
    parser.add_argument('--disposable-runner', action='store_true', required=True)
    parser.add_argument('--worker-root', help=argparse.SUPPRESS)
    parser.add_argument('--deadline-epoch-ms', type=int, help=argparse.SUPPRESS)
    parser.add_argument('--start-gate-handle', type=int, help=argparse.SUPPRESS)
    args = parser.parse_args()
    fixture.require(os.name == 'nt', 'Only a disposable Windows runner is supported')
    fixture.require(args.job == 181 and re.fullmatch('[a-f0-9]{40}', args.source), 'Require exact Windows build 181 and source SHA')
    fixture.require(args.node and Path(args.node).is_file(), 'Node >=22 is required for native WebSocket CDP')
    if args.worker_root:
        return worker(args)
    out = Path(args.output).resolve()
    fixture.require(not out.exists(), 'Never overwrite an existing result directory')
    out.mkdir(parents=True)
    root = Path(tempfile.mkdtemp(prefix='zentra-volume-1909-')).resolve()
    deadline = time.time() + 600
    # Reserve the last five seconds for terminating and awaiting the owned worker.
    worker_deadline = deadline - 5
    command = [sys.executable, str(Path(__file__).resolve()), '--job', str(args.job), '--source', args.source,
               '--schema', str(args.schema), '--output', str(out), '--node', str(Path(args.node).resolve()),
               '--job-layout', args.job_layout,
               '--disposable-runner', '--worker-root', str(root), '--deadline-epoch-ms', str(round(worker_deadline * 1000))]
    close_job, proc = None, None
    with (out / 'runner.log').open('wb') as log:
        try:
            proc, close_job = (launch_owned_worker(command, log) if args.job_layout == 'strict' else
                               launch_owned_worker(command, log, args.job_layout))
            if hasattr(close_job, 'evidence'):
                fixture.write_json(out / 'containment.json', close_job.evidence)
            code = proc.wait(timeout=remaining(worker_deadline, 595))
        except Exception as error:
            # Stop the worker before writing the final watchdog result so a late
            # worker cannot overwrite it with a success/partial status.
            if close_job:
                close_job(); close_job = None
                proc.wait(timeout=5)
            elif proc is not None and proc.poll() is None:
                stop_tree(proc)
            fixture.write_json(out / 'result.json', {'status': 'not_measured', 'measured': False,
                'reason': f'{type(error).__name__}: supervisor deadline or ownership failure',
                'scope': 'No complete IPC/UI result; partial evidence only', 'profile': str(root / 'profile')})
            code = 2
        finally:
            if close_job: close_job()
            elif proc is not None and proc.poll() is None: stop_tree(proc)
    print(json.dumps({'result': str(out / 'result.json'), 'exitCode': code}))
    return code


if __name__ == '__main__':
    sys.exit(main())
