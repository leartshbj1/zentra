"""Create an owned, suspended Windows worker with a verified restricted token.

The caller must attach its Job Objects before resume() and must keep the inherited
start event closed until ownership is established. This helper never starts an
application, changes the current token, loads a profile, or retries elevated.
"""

import ctypes
from ctypes import wintypes
import math
import os
from pathlib import Path
import subprocess


class _SidAndAttributes(ctypes.Structure):
    _fields_ = [('sid', ctypes.c_void_p), ('attributes', wintypes.DWORD)]


class _TokenGroups(ctypes.Structure):
    _fields_ = [('count', wintypes.DWORD), ('groups', _SidAndAttributes * 1)]


class _StartupInfo(ctypes.Structure):
    _fields_ = [('cb', wintypes.DWORD), ('reserved', wintypes.LPWSTR),
                ('desktop', wintypes.LPWSTR), ('title', wintypes.LPWSTR),
                ('x', wintypes.DWORD), ('y', wintypes.DWORD),
                ('x_size', wintypes.DWORD), ('y_size', wintypes.DWORD),
                ('x_chars', wintypes.DWORD), ('y_chars', wintypes.DWORD),
                ('fill', wintypes.DWORD), ('flags', wintypes.DWORD),
                ('show', wintypes.WORD), ('reserved_size', wintypes.WORD),
                ('reserved_bytes', ctypes.POINTER(ctypes.c_ubyte)),
                ('stdin', wintypes.HANDLE), ('stdout', wintypes.HANDLE),
                ('stderr', wintypes.HANDLE)]


class _StartupInfoEx(ctypes.Structure):
    _fields_ = [('startup', _StartupInfo), ('attributes', ctypes.c_void_p)]


class _ProcessInformation(ctypes.Structure):
    _fields_ = [('process', wintypes.HANDLE), ('thread', wintypes.HANDLE),
                ('pid', wintypes.DWORD), ('thread_id', wintypes.DWORD)]


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _apis():
    _require(os.name == 'nt', 'Restricted volume workers require Windows')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)

    def declare(dll, name, args, result=wintypes.BOOL):
        fn = getattr(dll, name)
        fn.argtypes, fn.restype = args, result

    handle, pointer = wintypes.HANDLE, ctypes.c_void_p
    dword, pdword = wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)
    phandle = ctypes.POINTER(handle)
    declare(kernel, 'GetCurrentProcess', [], handle)
    declare(kernel, 'CloseHandle', [handle])
    declare(kernel, 'LocalFree', [pointer], pointer)
    declare(kernel, 'GetHandleInformation', [handle, pdword])
    declare(kernel, 'DuplicateHandle', [handle, handle, handle, phandle,
                                      dword, wintypes.BOOL, dword])
    declare(kernel, 'InitializeProcThreadAttributeList',
            [pointer, dword, dword, ctypes.POINTER(ctypes.c_size_t)])
    declare(kernel, 'UpdateProcThreadAttribute',
            [pointer, dword, ctypes.c_size_t, pointer, ctypes.c_size_t, pointer, pointer])
    declare(kernel, 'DeleteProcThreadAttributeList', [pointer], None)
    declare(kernel, 'WaitForSingleObject', [handle, dword], dword)
    declare(kernel, 'GetExitCodeProcess', [handle, pdword])
    declare(kernel, 'TerminateProcess', [handle, wintypes.UINT])
    declare(kernel, 'ResumeThread', [handle], dword)
    declare(advapi, 'OpenProcessToken', [handle, dword, phandle])
    declare(advapi, 'GetTokenInformation', [handle, ctypes.c_int, pointer, dword, pdword])
    declare(advapi, 'CreateRestrictedToken',
            [handle, dword, dword, ctypes.POINTER(_SidAndAttributes),
             dword, pointer, dword, pointer, phandle])
    declare(advapi, 'SetTokenInformation', [handle, ctypes.c_int, pointer, dword])
    declare(advapi, 'ConvertStringSidToSidW', [wintypes.LPCWSTR, ctypes.POINTER(pointer)])
    declare(advapi, 'IsValidSid', [pointer])
    declare(advapi, 'GetLengthSid', [pointer], dword)
    declare(advapi, 'CopySid', [dword, pointer, pointer])
    declare(advapi, 'GetSidSubAuthorityCount', [pointer], ctypes.POINTER(ctypes.c_ubyte))
    declare(advapi, 'GetSidSubAuthority', [pointer, dword], pdword)
    declare(advapi, 'EqualSid', [pointer, pointer])
    declare(advapi, 'CreateProcessAsUserW',
            [handle, wintypes.LPCWSTR, wintypes.LPWSTR, pointer, pointer,
             wintypes.BOOL, dword, pointer, wintypes.LPCWSTR,
             ctypes.POINTER(_StartupInfoEx), ctypes.POINTER(_ProcessInformation)])
    return kernel, advapi


def _win_error():
    return ctypes.WinError(ctypes.get_last_error())


def _token_buffer(advapi, token, information_class):
    size = wintypes.DWORD()
    ctypes.set_last_error(0)
    success = advapi.GetTokenInformation(token, information_class, None, 0, ctypes.byref(size))
    if not success and ctypes.get_last_error() != 122:
        raise _win_error()
    _require(not success, 'Token-information sizing unexpectedly succeeded')
    _require(0 < size.value <= 65536, 'Unexpected token-information size')
    buffer = ctypes.create_string_buffer(size.value)
    capacity = size.value
    if not advapi.GetTokenInformation(token, information_class, buffer, capacity, ctypes.byref(size)):
        raise _win_error()
    _require(0 < size.value <= capacity, 'Invalid returned token-information size')
    return buffer, size.value


def _token_dword(advapi, token, information_class):
    value, size = wintypes.DWORD(), wintypes.DWORD()
    if not advapi.GetTokenInformation(token, information_class, ctypes.byref(value),
                                      ctypes.sizeof(value), ctypes.byref(size)):
        raise _win_error()
    _require(size.value == ctypes.sizeof(value), 'Unexpected token scalar size')
    return value.value


def _token_has_restrictions(advapi, token):
    # Microsoft documents DWORD here; this Windows runtime returns BOOLEAN (1
    # byte). Keep the four-byte destination zeroed and accept only these two
    # sizes for this specific information class, never for the other scalars.
    value, size = wintypes.DWORD(0), wintypes.DWORD()
    if not advapi.GetTokenInformation(token, 21, ctypes.byref(value),
                                      ctypes.sizeof(value), ctypes.byref(size)):
        raise _win_error()
    _require(size.value in (1, 4) and value.value in (0, 1),
             'Unexpected TokenHasRestrictions representation')
    return bool(value.value)


def _sid_bytes(advapi, sid):
    _require(sid and advapi.IsValidSid(sid), 'Invalid token SID')
    length = advapi.GetLengthSid(sid)
    _require(8 <= length <= 68, 'Unexpected token SID size')
    return ctypes.string_at(sid, length)


def _snapshot(advapi, token, admin_sid):
    """Private identity bytes never leave the helper; only metadata is exported."""
    user_buffer, user_size = _token_buffer(advapi, token, 1)  # TokenUser
    _require(user_size >= ctypes.sizeof(_SidAndAttributes), 'Truncated token user')
    user = ctypes.cast(user_buffer, ctypes.POINTER(_SidAndAttributes)).contents
    user_bytes = _sid_bytes(advapi, user.sid)
    integrity_buffer, integrity_size = _token_buffer(advapi, token, 25)  # TokenIntegrityLevel
    _require(integrity_size >= ctypes.sizeof(_SidAndAttributes), 'Truncated token integrity')
    label = ctypes.cast(integrity_buffer, ctypes.POINTER(_SidAndAttributes)).contents
    _sid_bytes(advapi, label.sid)
    count = advapi.GetSidSubAuthorityCount(label.sid)[0]
    _require(count > 0, 'Integrity SID has no subauthority')
    rid = int(advapi.GetSidSubAuthority(label.sid, count - 1)[0])
    groups_buffer, groups_size = _token_buffer(advapi, token, 2)  # TokenGroups
    _require(groups_size >= _TokenGroups.groups.offset, 'Truncated token groups')
    count = ctypes.cast(groups_buffer, ctypes.POINTER(wintypes.DWORD)).contents.value
    _require(count <= 4096 and _TokenGroups.groups.offset +
             count * ctypes.sizeof(_SidAndAttributes) <= groups_size, 'Invalid token groups size')
    groups = ctypes.cast(ctypes.addressof(groups_buffer) + _TokenGroups.groups.offset,
                         ctypes.POINTER(_SidAndAttributes))
    admin_present, admin_enabled, admin_deny_only = False, False, False
    for index in range(count):
        group = groups[index]
        _sid_bytes(advapi, group.sid)
        if advapi.EqualSid(group.sid, admin_sid):
            admin_present = True
            admin_enabled = admin_enabled or bool(group.attributes & 0x4)  # SE_GROUP_ENABLED
            admin_deny_only = admin_deny_only or bool(group.attributes & 0x10)
    level = ('system' if rid >= 0x4000 else 'high' if rid >= 0x3000 else
             'medium' if rid >= 0x2000 else 'low' if rid >= 0x1000 else 'untrusted')
    return {'user': user_bytes, 'session': _token_dword(advapi, token, 12),
            'public': {'elevated': bool(_token_dword(advapi, token, 20)),
                       'integrityRid': rid, 'integrity': level,
                       'restricted': _token_has_restrictions(advapi, token),
                       'primary': _token_dword(advapi, token, 8) == 1,
                       'administratorsPresent': admin_present,
                       'administratorsEnabled': admin_enabled,
                       'administratorsDenyOnly': admin_deny_only}}


def _verify_restricted(snapshot, source):
    public = snapshot['public']
    _require(snapshot['user'] == source['user'], 'Restricted worker changed token user')
    _require(snapshot['session'] == source['session'], 'Restricted worker changed token session')
    _require(public['primary'], 'Restricted worker token is not primary')
    _require(public['elevated'] is False and public['integrityRid'] == 0x2000,
             'Restricted worker token must be non-elevated at medium integrity')
    _require(public['restricted'] is True, 'TokenHasRestrictions did not confirm filtering')
    _require(not public['administratorsEnabled'] and
             (not public['administratorsPresent'] or public['administratorsDenyOnly']),
             'Restricted worker retains an enabled Administrators group')


class NativeProcess:
    """Minimal Popen-compatible ownership wrapper; creation never resumes it."""

    def __init__(self, kernel, information, command, token_evidence):
        self._kernel = kernel
        self._handle = int(information.process)
        self._thread_handle = int(information.thread)
        self.pid = int(information.pid)
        self.args = list(command)
        self.returncode = None
        self.token_evidence = token_evidence
        self._resumed = False

    def _require_open(self):
        _require(bool(self._handle), 'Native process handle is closed')

    def _read_exit(self):
        value = wintypes.DWORD()
        if not self._kernel.GetExitCodeProcess(self._handle, ctypes.byref(value)):
            raise _win_error()
        self.returncode = int(value.value)
        return self.returncode

    def poll(self):
        if self.returncode is not None:
            return self.returncode
        self._require_open()
        status = self._kernel.WaitForSingleObject(self._handle, 0)
        if status == 258:  # WAIT_TIMEOUT; exit code 259 can also be a real exit code.
            return None
        if status == 0:
            return self._read_exit()
        if status == 0xFFFFFFFF:
            raise _win_error()
        raise OSError('Unexpected native process wait result')

    def wait(self, timeout=None):
        if self.returncode is not None:
            return self.returncode
        self._require_open()
        if timeout is None:
            milliseconds = 0xFFFFFFFF
        else:
            _require(math.isfinite(timeout) and timeout <= 4294967,
                     'Native wait timeout must be finite and bounded')
            milliseconds = max(0, math.ceil(timeout * 1000))
        status = self._kernel.WaitForSingleObject(self._handle, milliseconds)
        if status == 0:
            return self._read_exit()
        if status == 258:
            raise subprocess.TimeoutExpired(self.args, timeout)
        if status == 0xFFFFFFFF:
            raise _win_error()
        raise OSError('Unexpected native process wait result')

    def kill(self):
        if self.poll() is not None:
            return
        if not self._kernel.TerminateProcess(self._handle, 1):
            error = _win_error()
            if self.poll() is None:
                raise error

    def resume(self):
        self._require_open()
        if self._resumed:
            return
        _require(self.poll() is None, 'Cannot resume an exited native process')
        previous = self._kernel.ResumeThread(self._thread_handle)
        if previous == 0xFFFFFFFF:
            raise _win_error()
        _require(previous == 1, 'Unexpected worker thread suspension count')
        self._resumed = True
        if not self._kernel.CloseHandle(self._thread_handle):
            raise _win_error()
        self._thread_handle = 0

    def close(self):
        """Idempotent; an unresumed worker is terminated before closing its handle."""
        if not self._handle and not self._thread_handle:
            return
        failure = None
        if self._handle:
            try:
                # Cache an observed exit code before the process handle is gone.
                exited = self.poll() is not None
                if not self._resumed and not exited:
                    self.kill()
                    self.wait(timeout=5)
            except BaseException as error:
                failure = error
        for name in ('_thread_handle', '_handle'):
            handle = getattr(self, name)
            if handle:
                if not self._kernel.CloseHandle(handle) and failure is None:
                    failure = _win_error()
                setattr(self, name, 0)
        if failure is not None:
            raise failure


def create_restricted_worker(command: list[str], gate_handle: int, log) -> NativeProcess:
    """Return a verified, still-suspended worker, or fail without an elevated retry.

    command already contains the caller's start-gate argument. gate_handle remains
    caller-owned and must be inheritable. The parent's environment/session are
    retained; no user profile, account, privilege, registry, or ACL is modified.
    """
    _require(isinstance(command, list) and command and
             all(isinstance(arg, str) and '\0' not in arg for arg in command),
             'Worker command must be a non-empty list of strings without NUL')
    application = Path(command[0])
    _require(application.is_absolute() and application.is_file(),
             'Worker executable must be an existing absolute file')
    _require(type(gate_handle) is int and gate_handle > 0, 'Invalid worker gate handle')
    command_line = subprocess.list2cmdline(command)
    units = len(command_line.encode('utf-16-le')) // 2 + 1
    _require(units <= 32767, 'Worker command exceeds the Windows limit')
    mutable_command = ctypes.create_unicode_buffer(units)
    mutable_command.value = command_line
    kernel, advapi = _apis()
    source_token, prepared_token, actual_token = wintypes.HANDLE(), wintypes.HANDLE(), wintypes.HANDLE()
    admin_sid, medium_sid = ctypes.c_void_p(), ctypes.c_void_p()
    temporary_handles = []
    attributes, attributes_initialized, proc, failure = None, False, None, None
    evidence = {'method': 'CreateRestrictedToken(LUA_TOKEN|DISABLE_MAX_PRIVILEGE)',
                'source': None, 'prepared': None, 'actual': None,
                'sameUser': False, 'sameSession': False, 'restricted': False}

    def duplicate_inheritable(handle):
        duplicate = wintypes.HANDLE()
        if not kernel.DuplicateHandle(kernel.GetCurrentProcess(), handle, kernel.GetCurrentProcess(),
                                      ctypes.byref(duplicate), 0, True, 2):  # DUPLICATE_SAME_ACCESS
            raise _win_error()
        temporary_handles.append(duplicate.value)
        return duplicate.value

    try:
        gate_flags = wintypes.DWORD()
        if not kernel.GetHandleInformation(gate_handle, ctypes.byref(gate_flags)):
            raise _win_error()
        _require(gate_flags.value & 1, 'Worker gate must already be inheritable')
        if not advapi.ConvertStringSidToSidW('S-1-5-32-544', ctypes.byref(admin_sid)):
            raise _win_error()
        if not advapi.ConvertStringSidToSidW('S-1-16-8192', ctypes.byref(medium_sid)):
            raise _win_error()
        # RestrictedToken preserves these handle rights; no privilege is enabled.
        if not advapi.OpenProcessToken(kernel.GetCurrentProcess(), 0x008B, ctypes.byref(source_token)):
            raise _win_error()  # ASSIGN_PRIMARY | DUPLICATE | QUERY | ADJUST_DEFAULT
        source = _snapshot(advapi, source_token, admin_sid)
        evidence['source'] = source['public']
        disabled = _SidAndAttributes(admin_sid.value, 0)
        if not advapi.CreateRestrictedToken(source_token, 0x5, 1, ctypes.byref(disabled),
                                             0, None, 0, None, ctypes.byref(prepared_token)):
            raise _win_error()
        sid_length = advapi.GetLengthSid(medium_sid)
        _require(8 <= sid_length <= 68, 'Unexpected medium integrity SID size')
        mandatory_buffer = ctypes.create_string_buffer(ctypes.sizeof(_SidAndAttributes) + sid_length)
        mandatory = ctypes.cast(mandatory_buffer, ctypes.POINTER(_SidAndAttributes)).contents
        mandatory.sid = ctypes.addressof(mandatory_buffer) + ctypes.sizeof(_SidAndAttributes)
        mandatory.attributes = 0x20  # SE_GROUP_INTEGRITY
        if not advapi.CopySid(sid_length, mandatory.sid, medium_sid):
            raise _win_error()
        if not advapi.SetTokenInformation(prepared_token, 25, mandatory_buffer,
                                          ctypes.sizeof(mandatory_buffer)):
            raise _win_error()
        prepared = _snapshot(advapi, prepared_token, admin_sid)
        evidence['prepared'] = prepared['public']
        evidence['sameUser'] = prepared['user'] == source['user']
        evidence['sameSession'] = prepared['session'] == source['session']
        evidence['restricted'] = prepared['public']['restricted']
        _verify_restricted(prepared, source)

        import msvcrt
        log.flush()
        output_handle = duplicate_inheritable(msvcrt.get_osfhandle(log.fileno()))
        with open(os.devnull, 'rb') as null_input:
            input_handle = duplicate_inheritable(msvcrt.get_osfhandle(null_input.fileno()))
        handles = (wintypes.HANDLE * 3)(gate_handle, output_handle, input_handle)
        size = ctypes.c_size_t()
        ctypes.set_last_error(0)
        success = kernel.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
        if not success and ctypes.get_last_error() != 122:
            raise _win_error()
        _require(not success and 0 < size.value <= 65536, 'Unexpected process-attribute sizing result')
        attributes = ctypes.create_string_buffer(size.value)
        if not kernel.InitializeProcThreadAttributeList(attributes, 1, 0, ctypes.byref(size)):
            raise _win_error()
        attributes_initialized = True
        if not kernel.UpdateProcThreadAttribute(attributes, 0, 0x00020002, handles,
                                                 ctypes.sizeof(handles), None, None):
            raise _win_error()  # PROC_THREAD_ATTRIBUTE_HANDLE_LIST
        startup = _StartupInfoEx()
        startup.startup.cb = ctypes.sizeof(startup)
        startup.startup.flags = 0x101  # USESTDHANDLES | USESHOWWINDOW
        startup.startup.show = 0  # SW_HIDE
        startup.startup.stdin, startup.startup.stdout = input_handle, output_handle
        startup.startup.stderr = output_handle
        startup.attributes = ctypes.addressof(attributes)
        information = _ProcessInformation()
        # The inherited environment and desktop are those of this same user and
        # session. The initial thread cannot run before the caller attaches Jobs.
        flags = 0x4 | 0x00080000 | 0x00000200  # SUSPENDED | EXTENDED_STARTUPINFO | NEW_PROCESS_GROUP
        if not advapi.CreateProcessAsUserW(prepared_token, str(application), mutable_command,
                                           None, None, True, flags, None, None,
                                           ctypes.byref(startup), ctypes.byref(information)):
            raise _win_error()
        proc = NativeProcess(kernel, information, command, evidence)
        if not advapi.OpenProcessToken(proc._handle, 0x8, ctypes.byref(actual_token)):
            raise _win_error()
        actual = _snapshot(advapi, actual_token, admin_sid)
        evidence['actual'] = actual['public']
        evidence['sameUser'] = (prepared['user'] == actual['user'] == source['user'])
        evidence['sameSession'] = (prepared['session'] == actual['session'] == source['session'])
        evidence['restricted'] = (prepared['public']['restricted'] and actual['public']['restricted'])
        _verify_restricted(actual, source)
    except BaseException as error:
        failure = error
    finally:
        # Cleanup errors cannot replace the original WinError (including 1314).
        cleanup_errors = []
        if attributes_initialized:
            try:
                kernel.DeleteProcThreadAttributeList(attributes)
            except BaseException as error:
                cleanup_errors.append(error)
        for handle in [*temporary_handles, actual_token.value, prepared_token.value, source_token.value]:
            if handle:
                try:
                    if not kernel.CloseHandle(handle):
                        cleanup_errors.append(_win_error())
                except BaseException as error:
                    cleanup_errors.append(error)
        for sid in (medium_sid, admin_sid):
            if sid.value:
                try:
                    if kernel.LocalFree(sid):
                        cleanup_errors.append(_win_error())
                except BaseException as error:
                    cleanup_errors.append(error)
        for error in cleanup_errors:
            if failure is None:
                failure = error
            else:
                failure.add_note(f'Cleanup also failed: {type(error).__name__}; winerror={getattr(error, "winerror", None)}')
    if failure is not None:
        if proc is not None:
            try:
                proc.close()  # Still suspended: terminate, await, then close both handles.
            except BaseException as error:
                failure.add_note(f'Suspended worker cleanup failed: {type(error).__name__}; winerror={getattr(error, "winerror", None)}')
        failure.token_evidence = evidence
        raise failure
    return proc
