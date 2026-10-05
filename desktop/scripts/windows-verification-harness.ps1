# Loaded only by diagnostics verification or explicit CI release-preflight. Production resources,
# build.rs, DLLs and application executables are never modified here.
Set-StrictMode -Version Latest

function Assert-ZentraVerificationMode {
    param([string]$Source,
        [ValidateSet('diagnostics-verification','release-preflight')][string]$Mode = 'diagnostics-verification',
        [string]$Repository = '')
    if ($Mode -ceq 'release-preflight') {
        if ($env:ZENTRA_RELEASE_TEST_HARNESS -cne 'true' -or $env:CIRCLECI -cne 'true' -or $env:OS -cne 'Windows_NT') {
            throw 'Release-preflight requires the explicit Windows CircleCI test-harness opt-in.'
        }
        foreach ($name in @('ZENTRA_VERIFY_DIAGNOSTICS_ONLY','ZENTRA_VERIFY_ONLY','ZENTRA_VERIFY_PDF_ONLY','ZENTRA_VERIFY_UPDATER_ONLY','ZENTRA_VERIFY_BACKUP_ONLY','ZENTRA_VERIFY_REPORTS_ONLY')) {
            $value = [Environment]::GetEnvironmentVariable($name,'Process')
            if (-not [string]::IsNullOrEmpty($value) -and $value -cne 'false') {
                throw 'Release-preflight cannot be combined with any verification-only mode.'
            }
        }
        if ($env:RUSTUP_TOOLCHAIN -cne 'stable-x86_64-pc-windows-msvc') {
            throw 'Release-preflight requires the same MSVC toolchain as the packaged application.'
        }
        if ([string]::IsNullOrWhiteSpace($Repository) -or -not (Test-Path -LiteralPath $Repository -PathType Container)) {
            throw 'Release-preflight requires the exact existing repository.'
        }
        $headLines = @(& git -C $Repository rev-parse HEAD)
        if ($LASTEXITCODE -ne 0 -or $headLines.Count -ne 1 -or [string]$headLines[0] -cne $Source) {
            throw 'Release-preflight requires HEAD to equal the exact CircleCI source.'
        }
    } elseif ($env:ZENTRA_VERIFY_DIAGNOSTICS_ONLY -cne 'true' -or $env:ZENTRA_VERIFY_ONLY -cne 'true') {
        throw 'The Windows test harness is available only in diagnostics verification-only mode.'
    }
    if ($Source -cnotmatch '^[0-9a-f]{40}$' -or $env:CIRCLE_SHA1 -cne $Source) {
        throw 'The Windows test harness requires the exact CircleCI source.'
    }
}

# Preserve the existing release call sites. Only this fixed cargo-test shape may
# be dispatched through a prepared library test binary; never fall back on a
# malformed or broadened invocation while the release opt-in is enabled.
function ConvertTo-ZentraReleaseTestInvocation {
    param([string]$Program, [string[]]$Arguments)
    if ($Program -cne 'cargo' -or $Arguments.Count -lt 8) {
        throw 'Unknown release-preflight cargo command shape.'
    }
    $prefix = @('test','--manifest-path','desktop/src-tauri/Cargo.toml','--locked','--lib')
    for ($index = 0; $index -lt $prefix.Count; $index++) {
        if ($Arguments[$index] -cne $prefix[$index]) { throw 'Unknown release-preflight cargo-test prefix.' }
    }
    $filter = $Arguments[5]
    if ($filter -cnotmatch '^[A-Za-z_][A-Za-z0-9_:]*$' -or $Arguments[6] -cne '--') {
        throw 'Unknown or empty release-preflight test filter.'
    }
    $tail = @($Arguments[7..($Arguments.Count - 1)])
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($argument in $tail) {
        if ($argument -cnotin @('--test-threads=1','--nocapture','--ignored','--exact') -or -not $seen.Add($argument)) {
            throw 'Unknown or duplicate release-preflight libtest argument.'
        }
    }
    if (($tail -ccontains '--ignored') -and -not ($tail -ccontains '--exact')) {
        throw 'Ignored release-preflight tests require an explicit exact filter.'
    }
    return [pscustomobject]@{Filter=$filter;TestArguments=[string[]]$tail}
}

function ConvertTo-ZentraWindowsArgument {
    param([AllowEmptyString()][string]$Value)
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

function Select-ZentraHarnessApplication {
    param([object[]]$Candidates)
    $first = @($Candidates | Select-Object -First 1)
    if ($first.Count -ne 1 -or $first[0].Source -isnot [string] -or [string]::IsNullOrWhiteSpace($first[0].Source)) {
        throw 'The verification tool must resolve to one application from the PATH.'
    }
    $source = $first[0].Source
    if (-not [IO.Path]::IsPathRooted($source) -or -not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw 'The selected verification application path is not an existing file.'
    }
    $file = Get-Item -LiteralPath $source
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'The selected verification application must be an ordinary file.'
    }
    return $file.FullName
}

function Get-ZentraHarnessApplicationMetadata {
    param([object[]]$Candidates)
    return @($Candidates | ForEach-Object {
        $source = [string]$_.Source
        $exists = -not [string]::IsNullOrWhiteSpace($source) -and (Test-Path -LiteralPath $source -PathType Leaf)
        $file = if ($exists) { Get-Item -LiteralPath $source } else { $null }
        $linkType = if ($null -ne $file -and $null -ne $file.PSObject.Properties['LinkType']) { $file.LinkType } else { $null }
        $target = @()
        if ($null -ne $file -and $null -ne $file.PSObject.Properties['Target']) { $target = @($file.Target) }
        [ordered]@{Name=$_.Name;Source=$source;exists=$exists;
            ordinaryFile=($exists -and -not $file.PSIsContainer -and -not ($file.Attributes -band [IO.FileAttributes]::ReparsePoint));
            linkType=$linkType;target=$target}
    })
}

function Resolve-ZentraToolchainCargo {
    param([object[]]$RustupCandidates, [string]$Toolchain, [string]$Repository, [string]$Artifacts, $Proof, [string]$ProofPath,
        [ValidateSet('diagnostics-verification','release-preflight')][string]$Mode = 'diagnostics-verification')
    Assert-ZentraVerificationMode $Proof.source $Mode $Repository
    $Proof.compileTool.resolutionMethod = 'rustup.which'
    $Proof.compileTool.toolchain = $Toolchain
    $Proof.compileTool.resolver = [ordered]@{candidates=@(Get-ZentraHarnessApplicationMetadata $RustupCandidates);selected=$null;exit=$null}
    try {
        if ($Toolchain -cne $env:RUSTUP_TOOLCHAIN -or $Toolchain -cnotmatch '^[A-Za-z0-9_.-]{1,120}$') {
            throw 'Cargo resolution requires the exact toolchain already selected by the verification script.'
        }
        if (-not (Test-Path -LiteralPath $Repository -PathType Container)) { throw 'The verification working directory does not exist.' }
        $rustup = Select-ZentraHarnessApplication $RustupCandidates
        if (-not [string]::Equals([IO.Path]::GetFileName($rustup),'rustup.exe',[StringComparison]::OrdinalIgnoreCase)) {
            throw 'The selected vendor resolver must be rustup.exe; do not fall back to another application.'
        }
        $Proof.compileTool.resolver.selected = $rustup
        Save-ZentraHarnessProof $Proof $ProofPath
        $stdout = Join-Path $Artifacts 'windows-test-harness-cargo-resolution.txt'
        $stderr = Join-Path $Artifacts 'windows-test-harness-cargo-resolution-errors.txt'
        $Proof.compileTool.resolver.exit = Invoke-ZentraHarnessTool $rustup @('which','cargo','--toolchain',$Toolchain) $Repository $stdout $stderr -Mode $Mode
        if ($Proof.compileTool.resolver.exit -ne 0) { throw 'The installed vendor could not resolve cargo for the selected toolchain.' }
        $lines = @(Get-Content -LiteralPath $stdout | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if ($lines.Count -ne 1) { throw 'The vendor must return exactly one nonempty cargo path.' }
        $resolved = $lines[0].Trim()
        $Proof.compileTool.resolvedOutput = $resolved
        if (-not [IO.Path]::IsPathRooted($resolved) -or -not [string]::Equals([IO.Path]::GetFileName($resolved),'cargo.exe',[StringComparison]::OrdinalIgnoreCase)) {
            throw 'The vendor cargo result must be an absolute cargo.exe path.'
        }
        $cargo = Select-ZentraHarnessApplication @([pscustomobject]@{Source=$resolved})
        $Proof.compileTool.selected = $cargo
        $Proof.compileTool.exists = $true
        $Proof.compileTool.ordinaryFile = $true
        return $cargo
    } finally {
        Save-ZentraHarnessProof $Proof $ProofPath
    }
}

function Invoke-ZentraHarnessTool {
    param([string]$Program, [string[]]$Arguments, [string]$Repository,
        [string]$Stdout, [string]$Stderr, [string]$HeartbeatMessage = 'Inspecting the verification-only harness.', [int]$TimeoutSeconds = 300,
        [ValidateSet('diagnostics-verification','release-preflight')][string]$Mode = 'diagnostics-verification', $CrashObservation = $null)
    Assert-ZentraVerificationMode $env:CIRCLE_SHA1 $Mode $Repository
    if ($null -ne $CrashObservation) {
        Assert-ZentraCrashObservationDispatch $Program $Arguments $Repository $Mode $CrashObservation
    }
    # Inherit the standard noninteractive error mode in disposable CI child
    # processes. Loader errors still return their real Windows status; this
    # prevents an error dialog from blocking the runner indefinitely.
    if (-not ('ZentraVerification.NativeErrors' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace ZentraVerification {
  public static class NativeErrors {
    [DllImport("kernel32.dll")]
    public static extern uint SetErrorMode(uint mode);
  }
}
'@
    }
    $argumentLine = (@($Arguments | ForEach-Object { ConvertTo-ZentraWindowsArgument $_ })) -join ' '
    $previousMode = [ZentraVerification.NativeErrors]::SetErrorMode(0x8003)
    try {
        $process = Start-Process -FilePath $Program -ArgumentList $argumentLine -WorkingDirectory $Repository `
            -WindowStyle Hidden -PassThru -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr
        # Retain the native process handle before the child exits. Windows
        # PowerShell 5.1 can otherwise expose a null ExitCode after WaitForExit.
        [void]$process.Handle
    } finally {
        [void][ZentraVerification.NativeErrors]::SetErrorMode($previousMode)
    }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        while (-not $process.WaitForExit(25000)) {
            if ($watch.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
                Stop-Process -Id $process.Id -Force
                throw 'A disposable verification child process exceeded its bounded timeout.'
            }
            if ($null -ne $CrashObservation) { Update-ZentraCrashObservation $CrashObservation }
            Write-Host $HeartbeatMessage
        }
        $watch.Stop()
        $process.WaitForExit()
        # Poll once more even when the child exited before the first heartbeat.
        if ($null -ne $CrashObservation) { Update-ZentraCrashObservation $CrashObservation -Terminal }
        $exitCode = $process.ExitCode
        if ($null -eq $exitCode) { throw 'The verification child exit code is unavailable; do not infer success.' }
        return [int]$exitCode
    } finally {
        if ($null -ne $CrashObservation -and $null -ne $CrashObservation.Stream) {
            try { $CrashObservation.Stream.Dispose() } catch { Set-ZentraCrashObservationFailure $CrashObservation 2 }
            $CrashObservation.Stream = $null
        }
    }
}

# Numeric closed protocol mirrors the parent aggregate's fixed catalogue. The
# observer never prints event text, native stdout, paths or exception messages.
function Get-ZentraCrashCatalogue {
    $restore = @('intent_published','database_staged','attachments_staged','old_database_renamed','old_attachments_renamed','new_database_renamed','new_attachments_renamed','finalized','commit_published','cleanup_database_removed','cleanup_attachments_removed','cleanup_auxiliary_file_company-collaboration.json','cleanup_auxiliary_file_company-sync-baseline.json','cleanup_auxiliary_file_company-sync-reference.zentra','cleanup_auxiliary_file_cloud-backup-state.json','cleanup_auxiliary_file_backup-status.json','cleanup_auxiliary_file_joined-company-copy.json','cleanup_auxiliary_removed','cleanup_journal_removed')
    $rollback = @('rollback_new_database_removed','rollback_database_restored','rollback_new_attachments_removed','rollback_attachments_restored','rollback_auxiliary_company-collaboration.json','rollback_auxiliary_company-sync-baseline.json','rollback_auxiliary_company-sync-reference.zentra','rollback_auxiliary_cloud-backup-state.json','rollback_auxiliary_backup-status.json','rollback_auxiliary_joined-company-copy.json','rollback_published') + @($restore[9..18])
    $catalogue = [Collections.Generic.List[object]]::new()
    foreach ($mode in @(1,2)) {
        foreach ($group in @(1,2)) {
            $boundaries = if ($group -eq 1) { $restore } else { $rollback }
            for ($boundary = 0; $boundary -lt $boundaries.Count; $boundary++) {
                $phase = $boundaries[$boundary]
                $restoreIndex = [Array]::IndexOf($restore,$phase)
                $checkpoint = if ($restoreIndex -ge 0) { $restoreIndex + 1 } else { $boundary + 20 }
                $catalogue.Add([pscustomobject]@{caseIndex=$catalogue.Count;mode=$mode;group=$group;boundary=$boundary;phase=$phase;checkpoint=$checkpoint})
            }
        }
    }
    return ,$catalogue.ToArray()
}

function Get-ZentraCrashExpectedEvents {
    $events = [Collections.Generic.List[object]]::new()
    $completed=0; $kills=0
    $events.Add([pscustomobject]@{caseIndex=80;mode=0;group=0;boundary=0;stage=0;ordinal=0;checkpoint=0;completedCases=0;confirmedKills=0;status=0;failureCategory=0})
    foreach ($case in (Get-ZentraCrashCatalogue)) {
        foreach ($stage in @(1,2,3,4)) {
            $events.Add([pscustomobject]@{caseIndex=$case.caseIndex;mode=$case.mode;group=$case.group;boundary=$case.boundary;stage=$stage;ordinal=0;checkpoint=0;completedCases=$completed;confirmedKills=$kills;status=0;failureCategory=0})
        }
        $ordinals=if ($case.group -eq 1) { @(1) } else { @(1,2) }
        foreach ($ordinal in $ordinals) {
            $checkpoint=if ($case.group -eq 2 -and $ordinal -eq 1) { 8 } else { $case.checkpoint }
            foreach ($stage in @(5,6,7,8)) {
                if ($stage -eq 8) { $kills++ }
                $events.Add([pscustomobject]@{caseIndex=$case.caseIndex;mode=$case.mode;group=$case.group;boundary=$case.boundary;stage=$stage;ordinal=$ordinal;checkpoint=$checkpoint;completedCases=$completed;confirmedKills=$kills;status=0;failureCategory=0})
            }
        }
        foreach ($stage in @(9,10,11,12)) {
            if ($stage -eq 12) { $completed++ }
            $events.Add([pscustomobject]@{caseIndex=$case.caseIndex;mode=$case.mode;group=$case.group;boundary=$case.boundary;stage=$stage;ordinal=0;checkpoint=0;completedCases=$completed;confirmedKills=$kills;status=0;failureCategory=0})
        }
    }
    $events.Add([pscustomobject]@{caseIndex=80;mode=0;group=0;boundary=0;stage=13;ordinal=0;checkpoint=0;completedCases=80;confirmedKills=122;status=1;failureCategory=0})
    return ,$events.ToArray()
}

function Assert-ZentraCrashOrdinaryPath {
    param([string]$Path)
    $cursor=[IO.Path]::GetFullPath($Path)
    $depth=0
    while (-not [string]::IsNullOrEmpty($cursor)) {
        $depth++
        if ($depth -gt 64) { throw 'Closed crash path bound.' }
        $item=$null
        try { $item=Get-Item -LiteralPath $cursor -ErrorAction Stop }
        catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw 'Closed crash metadata refusal.' } }
        if ($null -ne $item) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Closed crash path refusal.' }
        }
        $next=[IO.Path]::GetDirectoryName($cursor)
        if ($next -ceq $cursor) { break }
        $cursor=$next
    }
}

function Get-ZentraCrashOwnedRoot {
    param([string]$Repository)
    if (-not [IO.Path]::IsPathRooted($Repository) -or -not (Test-Path -LiteralPath $Repository -PathType Container)) { throw 'Closed crash repository refusal.' }
    $repo=[IO.Path]::GetFullPath($Repository).TrimEnd('\','/')
    $expected=[IO.Path]::GetFullPath((Join-Path $repo 'desktop/artifacts/recovery-route-witness/crash'))
    if ([string]::IsNullOrEmpty($env:ZENTRA_RECOVERY_CRASH_PROOF) -or -not [IO.Path]::IsPathRooted($env:ZENTRA_RECOVERY_CRASH_PROOF) -or -not [string]::Equals([IO.Path]::GetFullPath($env:ZENTRA_RECOVERY_CRASH_PROOF),$expected,[StringComparison]::OrdinalIgnoreCase)) { throw 'Closed crash owned root refusal.' }
    Assert-ZentraCrashOrdinaryPath $expected
    return $expected
}

function New-ZentraCrashObservation {
    param([string]$Repository)
    $root=Get-ZentraCrashOwnedRoot $Repository
    # This pre-spawn guard refuses evidence from an earlier native execution.
    if (Test-Path -LiteralPath $root) { throw 'Crash evidence already exists; do not resume it.' }
    return [pscustomobject]@{Repository=[IO.Path]::GetFullPath($Repository);Root=$root;Stream=$null;CreationTicks=0L;Offset=0L;
        Tail=[Collections.Generic.List[byte]]::new();Expected=(Get-ZentraCrashExpectedEvents);EventCount=0;
        LastElapsed=0L;LastWriterMicros=0L;Last=$null;TerminalState=0;Error=0;FinalPolled=$false;LastPrintedSequence=0}
}

function Test-ZentraCrashObservationSelection {
    param([string]$Suite,[string[]]$ExtraArguments,[string]$Mode)
    return ($Mode -ceq 'diagnostics-verification' -and $Suite -ceq 'backup::recovery_crash_tests::native_crash_boundaries_restore_one_complete_profile_before_migration' -and $ExtraArguments.Count -eq 2 -and $ExtraArguments -ccontains '--exact' -and $ExtraArguments -ccontains '--ignored')
}

function Assert-ZentraCrashObservationDispatch {
    param([string]$Program,[string[]]$Arguments,[string]$Repository,[string]$Mode,$Observation)
    if ($Arguments.Count -ne 4 -or $Arguments[1] -cne '--test-threads=1' -or -not (Test-ZentraCrashObservationSelection $Arguments[0] @($Arguments[2],$Arguments[3]) $Mode)) { throw 'Closed crash observer dispatch refusal.' }
    $deps=[IO.Path]::GetFullPath((Join-Path $Repository 'desktop/src-tauri/target/release/deps'))
    if (-not [string]::Equals([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Program)),$deps,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($Program) -cnotmatch '^helvichantier_lib-[0-9a-f]{16}\.exe$') { throw 'Closed crash executable refusal.' }
    $expected=Get-ZentraCrashOwnedRoot $Repository
    if (-not [string]::Equals($Observation.Repository,[IO.Path]::GetFullPath($Repository),[StringComparison]::OrdinalIgnoreCase) -or -not [string]::Equals($Observation.Root,$expected,[StringComparison]::OrdinalIgnoreCase) -or $Observation.Offset -ne 0 -or $Observation.EventCount -ne 0 -or $Observation.Error -ne 0 -or $null -ne $Observation.Stream) { throw 'Closed crash context refusal.' }
}

function Set-ZentraCrashObservationFailure {
    param($Observation,[int]$Category)
    if ($Observation.Error -eq 0) { $Observation.Error=$Category }
}

function Add-ZentraCrashProgressLine {
    param($Observation,[byte[]]$Bytes)
    if ($Observation.Error -ne 0) { return }
    if ($Bytes.Length -gt 1024 -or $Bytes.Length -eq 0 -or $Observation.EventCount -ge 1280) { Set-ZentraCrashObservationFailure $Observation 5; return }
    foreach ($byte in $Bytes) { if ($byte -gt 127) { Set-ZentraCrashObservationFailure $Observation 3; return } }
    # Exact ordering and spellings reject unknown, duplicate, aliased, escaped
    # and nested fields, plus every numeric coercion/float/negative form.
    $number='(0|[1-9][0-9]{0,9})'
    $fields=@('v','sequence','caseIndex','mode','group','boundary','stage','ordinal','checkpoint','elapsedMs','proofWriteElapsedMicrosBefore','plannedCases','plannedKills','completedCases','confirmedKills','status','failureCategory')
    $parts=@($fields | ForEach-Object { '"'+$_+'":(?<'+$_+'>'+ $number +')' })
    $pattern='\A\{'+($parts -join ',')+'\}\z'
    $match=[regex]::Match([Text.Encoding]::ASCII.GetString($Bytes),$pattern)
    if (-not $match.Success) { Set-ZentraCrashObservationFailure $Observation 3; return }
    $event=@{}
    foreach ($field in $fields) { $event[$field]=[UInt64]::Parse($match.Groups[$field].Value,[Globalization.CultureInfo]::InvariantCulture) }
    if ($event.v -ne 1 -or $event.plannedCases -ne 80 -or $event.plannedKills -ne 122 -or $event.sequence -ne ($Observation.EventCount+1) -or $event.elapsedMs -gt 5400000 -or $event.proofWriteElapsedMicrosBefore -gt ($event.elapsedMs*1000+999) -or $event.elapsedMs -lt $Observation.LastElapsed -or $event.proofWriteElapsedMicrosBefore -lt $Observation.LastWriterMicros -or $event.completedCases -gt 80 -or $event.confirmedKills -gt 122 -or $Observation.TerminalState -ne 0) { Set-ZentraCrashObservationFailure $Observation 4; return }
    if ($event.stage -eq 14) {
        if ($event.status -ne 2 -or $event.failureCategory -notin @(1,2) -or $Observation.EventCount -eq 0) { Set-ZentraCrashObservationFailure $Observation 4; return }
        $next=$Observation.Expected[[Math]::Min($Observation.EventCount,1129)]
        $previous=$Observation.Last
        $tupleFields=@('caseIndex','mode','group','boundary','ordinal','checkpoint')
        $matchesPrevious=$true; $matchesNext=$true
        foreach ($field in $tupleFields) {
            if ($event[$field] -ne $previous[$field]) { $matchesPrevious=$false }
            if ($event[$field] -ne $next.$field) { $matchesNext=$false }
        }
        if ((-not $matchesPrevious -and -not $matchesNext) -or $event.completedCases -lt $previous.completedCases -or $event.completedCases -gt $next.completedCases -or $event.confirmedKills -lt $previous.confirmedKills -or $event.confirmedKills -gt $next.confirmedKills -or $event.ordinal -gt 2 -or $event.checkpoint -gt 30) { Set-ZentraCrashObservationFailure $Observation 4; return }
        $Observation.TerminalState=2
    } else {
        if ($Observation.EventCount -ge 1130) { Set-ZentraCrashObservationFailure $Observation 4; return }
        $expected=$Observation.Expected[$Observation.EventCount]
        foreach ($field in @('caseIndex','mode','group','boundary','stage','ordinal','checkpoint','completedCases','confirmedKills','status','failureCategory')) {
            if ($event[$field] -ne $expected.$field) { Set-ZentraCrashObservationFailure $Observation 4; return }
        }
        if ($event.stage -eq 13) { $Observation.TerminalState=1 }
    }
    $Observation.EventCount++
    $Observation.LastElapsed=[long]$event.elapsedMs
    $Observation.LastWriterMicros=[long]$event.proofWriteElapsedMicrosBefore
    $Observation.Last=$event
}

function Update-ZentraCrashObservation {
    param($Observation,[switch]$Terminal)
    # Observation errors are deliberately retained, never thrown into the
    # process wait loop. The native process remains monitored to its real exit
    # or its unchanged timeout, after which final admission is refused.
    if ($Terminal) { $Observation.FinalPolled=$true }
    if ($Observation.Error -ne 0) { return }
    try {
        $root=Get-ZentraCrashOwnedRoot $Observation.Repository
        if (-not [string]::Equals($root,$Observation.Root,[StringComparison]::OrdinalIgnoreCase)) { throw 'Closed root mismatch.' }
        $path=Join-Path $root 'progress.jsonl'
        Assert-ZentraCrashOrdinaryPath $path
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            if ($Terminal -or $null -ne $Observation.Stream) { Set-ZentraCrashObservationFailure $Observation 7 }
            return
        }
        $item=Get-Item -LiteralPath $path
        if ($item.PSIsContainer -or $item.Length -gt 2097152) { Set-ZentraCrashObservationFailure $Observation 5; return }
        if ($null -eq $Observation.Stream) {
            $Observation.Stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
            $Observation.CreationTicks=$item.CreationTimeUtc.Ticks
        }
        # A retained handle denies deletion. Metadata checks additionally catch
        # observed replacements/shrinkage; no hostile-concurrency claim follows.
        if (-not [string]::Equals($Observation.Stream.Name,[IO.Path]::GetFullPath($path),[StringComparison]::OrdinalIgnoreCase) -or $item.CreationTimeUtc.Ticks -ne $Observation.CreationTicks -or $item.Length -lt $Observation.Offset -or $Observation.Stream.Length -lt $Observation.Offset) { Set-ZentraCrashObservationFailure $Observation 6; return }
        $buffer=[byte[]]::new(65536)
        while ($Observation.Stream.Position -lt $Observation.Stream.Length -and $Observation.Error -eq 0) {
            $read=$Observation.Stream.Read($buffer,0,[Math]::Min($buffer.Length,2097153-$Observation.Offset))
            if ($read -eq 0) { break }
            $Observation.Offset+=$read
            if ($Observation.Offset -gt 2097152) { Set-ZentraCrashObservationFailure $Observation 5; break }
            for ($index=0; $index -lt $read -and $Observation.Error -eq 0; $index++) {
                if ($buffer[$index] -eq 10) {
                    Add-ZentraCrashProgressLine $Observation $Observation.Tail.ToArray()
                    $Observation.Tail.Clear()
                } else {
                    $Observation.Tail.Add($buffer[$index])
                    if ($Observation.Tail.Count -gt 1024) { Set-ZentraCrashObservationFailure $Observation 5 }
                }
            }
        }
        if ($Terminal -and ($Observation.Tail.Count -ne 0 -or $Observation.TerminalState -ne 1 -or $Observation.EventCount -ne 1130)) { Set-ZentraCrashObservationFailure $Observation 7 }
        if ($Observation.Last -ne $null -and $Observation.Last.sequence -ne $Observation.LastPrintedSequence) {
            $Observation.LastPrintedSequence=$Observation.Last.sequence
            Write-Host ('Recovery progress: case={0}/80 kills={1}/122 stage={2} elapsedMs={3} priorProofWriteMicros={4}' -f $Observation.Last.completedCases,$Observation.Last.confirmedKills,$Observation.Last.stage,$Observation.Last.elapsedMs,$Observation.Last.proofWriteElapsedMicrosBefore)
        }
    } catch {
        Set-ZentraCrashObservationFailure $Observation 2
    }
}

function Read-ZentraCrashOutcomeToken {
    param([string]$Raw,[ref]$Offset)
    while ($Offset.Value -lt $Raw.Length -and $Raw[$Offset.Value] -cin @([char]32,[char]9,[char]10,[char]13)) { $Offset.Value++ }
    if ($Offset.Value -eq $Raw.Length) { return $null }
    $character=$Raw[$Offset.Value]
    $Offset.Value++
    $punctuation=@{'{'=1;'}'=2;'['=3;']'=4;':'=5;','=6}
    if ($punctuation.ContainsKey([string]$character)) { return [pscustomobject]@{Kind=$punctuation[[string]$character];Text='';Escaped=$false} }
    if ($character -ceq '"') {
        $start=$Offset.Value; $escaped=$false
        while ($Offset.Value -lt $Raw.Length) {
            $character=$Raw[$Offset.Value]
            $Offset.Value++
            if ($character -ceq '"') { return [pscustomobject]@{Kind=7;Text=$Raw.Substring($start,$Offset.Value-$start-1);Escaped=$escaped} }
            if ([int]$character -lt 32) { throw 'Closed outcomes string control refusal.' }
            if ($character -ceq '\') {
                $escaped=$true
                if ($Offset.Value -ge $Raw.Length) { throw 'Closed outcomes string tail refusal.' }
                $escape=$Raw[$Offset.Value]; $Offset.Value++
                if ($escape -ceq 'u') {
                    if ($Offset.Value+4 -gt $Raw.Length -or $Raw.Substring($Offset.Value,4) -cnotmatch '^[0-9a-fA-F]{4}$') { throw 'Closed outcomes string escape refusal.' }
                    $Offset.Value+=4
                } elseif ($escape -cnotin @('"','\','/','b','f','n','r','t')) { throw 'Closed outcomes string escape refusal.' }
            }
        }
        throw 'Closed outcomes unclosed string refusal.'
    }
    if ($character -ceq 't' -and $Offset.Value+3 -le $Raw.Length -and $Raw.Substring($Offset.Value,3) -ceq 'rue') { $Offset.Value+=3; return [pscustomobject]@{Kind=8;Text='';Escaped=$false} }
    if ($character -ceq 'f' -and $Offset.Value+4 -le $Raw.Length -and $Raw.Substring($Offset.Value,4) -ceq 'alse') { $Offset.Value+=4; return [pscustomobject]@{Kind=9;Text='';Escaped=$false} }
    throw 'Closed outcomes token refusal.'
}

function Assert-ZentraCrashOutcomeKeys {
    param([string]$Raw)
    if ($Raw.Length -eq 0 -or $Raw.Length -gt 2097152) { throw 'Closed outcomes scanner bound.' }
    $rootTypes=@{source=7;synthetic=8;nativeExecution=7;packageExecuted=8;actualTauriIpcExecuted=8;physicalPowerLossVerified=8;cases=3}
    $caseTypes=@{phase=7;recoveryInterrupted=8;completeArchive=8;result=7;nativeSqliteValidated=8;nativeWorkspaceRead=8;documentBase64Exact=8;managedLogoBase64Exact=8;auxiliaryExact=8;secondCleanReopen=8;archiveSha256=7;databaseSha256=7;artifactDirectory=7}
    $stack=[Collections.Generic.List[object]]::new()
    $offset=0; $opened=$false; $closed=$false; $caseCount=0
    while ($true) {
        $token=Read-ZentraCrashOutcomeToken $Raw ([ref]$offset)
        if ($null -eq $token) { break }
        if ($closed) { throw 'Closed outcomes extra root refusal.' }
        if (-not $opened) {
            if ($token.Kind -ne 1) { throw 'Closed outcomes root grammar refusal.' }
            $opened=$true
            $stack.Add([pscustomobject]@{Kind=1;Scope=1;State=0;Key='';Keys=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)})
            continue
        }
        if ($stack.Count -eq 0 -or $stack.Count -gt 3) { throw 'Closed outcomes nesting refusal.' }
        $frame=$stack[$stack.Count-1]
        if ($frame.Kind -eq 1) {
            $types=if ($frame.Scope -eq 1) {$rootTypes} else {$caseTypes}
            if (($frame.State -eq 0 -or $frame.State -eq 3) -and $token.Kind -eq 2) {
                if ($frame.Keys.Count -ne $types.Count) { throw 'Closed outcomes missing keys refusal.' }
                $stack.RemoveAt($stack.Count-1)
                if ($frame.Scope -eq 1) { $closed=$true }
                else { $caseCount++; if ($caseCount -gt 80) { throw 'Closed outcomes case count refusal.' } }
            } elseif ($frame.State -eq 0 -or $frame.State -eq 4) {
                # Key validation precedes JSON conversion, with ordinal identity
                # per object. Never decode aliases or count quoted value text.
                if ($token.Kind -ne 7 -or $token.Escaped -or -not $types.ContainsKey($token.Text) -or -not ($types.Keys -ccontains $token.Text) -or -not $frame.Keys.Add($token.Text)) { throw 'Closed outcomes key spelling or duplicate refusal.' }
                $frame.Key=$token.Text; $frame.State=1
            } elseif ($frame.State -eq 1) {
                if ($token.Kind -ne 5) { throw 'Closed outcomes colon refusal.' }
                $frame.State=2
            } elseif ($frame.State -eq 2) {
                $expectedKind=$types[$frame.Key]
                if ($expectedKind -eq 3) {
                    if ($token.Kind -ne 3 -or $frame.Scope -ne 1 -or $frame.Key -cne 'cases') { throw 'Closed outcomes array refusal.' }
                    $frame.State=3
                    $stack.Add([pscustomobject]@{Kind=2;Scope=0;State=0;Key='';Keys=$null})
                } else {
                    if (($expectedKind -eq 7 -and $token.Kind -ne 7) -or ($expectedKind -eq 8 -and $token.Kind -notin @(8,9))) { throw 'Closed outcomes primitive type refusal.' }
                    $frame.State=3
                }
            } elseif ($frame.State -eq 3) {
                if ($token.Kind -ne 6) { throw 'Closed outcomes object separator refusal.' }
                $frame.State=4
            } else { throw 'Closed outcomes object grammar refusal.' }
        } else {
            if (($frame.State -eq 0 -or $frame.State -eq 1) -and $token.Kind -eq 4) {
                if ($caseCount -ne 80) { throw 'Closed outcomes complete coverage refusal.' }
                $stack.RemoveAt($stack.Count-1)
            } elseif ($frame.State -eq 0 -or $frame.State -eq 2) {
                if ($token.Kind -ne 1) { throw 'Closed outcomes case object refusal.' }
                $frame.State=1
                $stack.Add([pscustomobject]@{Kind=1;Scope=2;State=0;Key='';Keys=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)})
            } elseif ($frame.State -eq 1) {
                if ($token.Kind -ne 6) { throw 'Closed outcomes array separator refusal.' }
                $frame.State=2
            } else { throw 'Closed outcomes array grammar refusal.' }
        }
    }
    if (-not $opened -or -not $closed -or $stack.Count -ne 0 -or $caseCount -ne 80) { throw 'Closed outcomes incomplete grammar refusal.' }
}

function Assert-ZentraCrashOutcomes {
    param($Observation,[string]$Source)
    $root=Get-ZentraCrashOwnedRoot $Observation.Repository
    $path=Join-Path $root 'outcomes.json'
    Assert-ZentraCrashOrdinaryPath $path
    $item=Get-Item -LiteralPath $path
    if ($item.PSIsContainer -or $item.Length -gt 2097152 -or $item.Length -eq 0) { throw 'Closed outcomes size refusal.' }
    $stream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        $bytes=[byte[]]::new(2097153); $length=0
        while ($length -lt $bytes.Length) {
            $read=$stream.Read($bytes,$length,$bytes.Length-$length)
            if ($read -eq 0) { break }
            $length+=$read
        }
        if ($length -gt 2097152 -or $length -eq 0) { throw 'Closed outcomes read bound.' }
        $raw=[Text.UTF8Encoding]::new($false,$true).GetString($bytes,0,$length)
    } finally { $stream.Dispose() }
    Assert-ZentraCrashOutcomeKeys $raw
    $document=$raw | ConvertFrom-Json
    $rootFields=@('source','synthetic','nativeExecution','packageExecuted','actualTauriIpcExecuted','physicalPowerLossVerified','cases')
    $caseFields=@('phase','recoveryInterrupted','completeArchive','result','nativeSqliteValidated','nativeWorkspaceRead','documentBase64Exact','managedLogoBase64Exact','auxiliaryExact','secondCleanReopen','archiveSha256','databaseSha256','artifactDirectory')
    if (@($document.PSObject.Properties).Count -ne $rootFields.Count -or $document.source -isnot [string] -or $document.source -cne $Source -or $document.synthetic -isnot [bool] -or -not $document.synthetic -or $document.nativeExecution -cne 'compiled-library-harness-with-owned-child-kills') { throw 'Closed outcomes identity refusal.' }
    foreach ($field in @('packageExecuted','actualTauriIpcExecuted','physicalPowerLossVerified')) { if ($document.$field -isnot [bool] -or $document.$field) { throw 'Closed outcomes limitations refusal.' } }
    if ($document.cases -isnot [array] -or $document.cases.Count -ne 80) { throw 'Closed outcomes coverage refusal.' }
    $catalogue=Get-ZentraCrashCatalogue
    for ($index=0; $index -lt 80; $index++) {
        $case=$document.cases[$index]; $expected=$catalogue[$index]
        if (@($case.PSObject.Properties).Count -ne $caseFields.Count -or $case.phase -cne $expected.phase -or $case.recoveryInterrupted -isnot [bool] -or $case.recoveryInterrupted -ne ($expected.group -eq 2) -or $case.completeArchive -isnot [bool] -or $case.completeArchive -ne ($expected.mode -eq 1) -or $case.artifactDirectory -cne ('c{0:D2}' -f $index)) { throw 'Closed outcomes case identity refusal.' }
        $committed=$expected.group -eq 1 -and ($expected.phase -ceq 'commit_published' -or $expected.phase.StartsWith('cleanup_'))
        $result=if ($committed) { 'committed-new-profile' } else { 'original-profile' }
        if ($case.result -cne $result -or $case.archiveSha256 -isnot [string] -or $case.archiveSha256 -cnotmatch '^[0-9a-f]{64}$' -or $case.databaseSha256 -isnot [string] -or $case.databaseSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Closed outcomes result refusal.' }
        foreach ($field in @('nativeSqliteValidated','nativeWorkspaceRead','documentBase64Exact','managedLogoBase64Exact','auxiliaryExact','secondCleanReopen')) { if ($case.$field -isnot [bool] -or -not $case.$field) { throw 'Closed outcomes assertion refusal.' } }
    }
}

function Get-ZentraCrashObservationReceipt {
    param($Observation)
    return [ordered]@{protocol=1;events=$Observation.EventCount;observedBytes=$Observation.Offset;completedCases=if ($null -eq $Observation.Last) {0} else {[int]$Observation.Last.completedCases};confirmedKills=if ($null -eq $Observation.Last) {0} else {[int]$Observation.Last.confirmedKills};terminalState=$Observation.TerminalState;observerFailureCategory=$Observation.Error;finalPolled=[bool]$Observation.FinalPolled;elapsedMs=$Observation.LastElapsed;proofWriteElapsedMicrosBefore=$Observation.LastWriterMicros;measurementLimit='Prior successful write/flush/sync only; excludes final append, creation, serialization and reader overhead. Instrumented runtime does not establish the prior timeout cause.'}
}

function Assert-ZentraCrashObservationAdmission {
    param($Observation,[string]$Source)
    if ($Observation.Error -ne 0 -or -not $Observation.FinalPolled -or $Observation.Tail.Count -ne 0 -or $Observation.TerminalState -ne 1 -or $Observation.EventCount -ne 1130 -or $null -eq $Observation.Last -or $Observation.Last.completedCases -ne 80 -or $Observation.Last.confirmedKills -ne 122) { throw 'Native crash progress is incomplete or refused; partial evidence is not admission.' }
    try { Assert-ZentraCrashOutcomes $Observation $Source } catch { Set-ZentraCrashObservationFailure $Observation 8; throw 'Native crash outcomes are incomplete or refused.' }
}

function Select-ZentraLibraryHarness {
    param([string]$Repository, [string[]]$CargoJsonLines,
        [ValidateSet('diagnostics-verification','release-preflight')][string]$Mode = 'diagnostics-verification')
    $repositoryPath = [IO.Path]::GetFullPath($Repository).TrimEnd('\', '/')
    $expectedSource = [IO.Path]::GetFullPath((Join-Path $repositoryPath 'desktop/src-tauri/src/lib.rs'))
    $depsRelative = if ($Mode -ceq 'release-preflight') { 'desktop/src-tauri/target/x86_64-pc-windows-msvc/release/deps' } else { 'desktop/src-tauri/target/release/deps' }
    $deps = [IO.Path]::GetFullPath((Join-Path $repositoryPath $depsRelative)).TrimEnd('\', '/')
    $selected = @()
    foreach ($line in $CargoJsonLines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $item = $line | ConvertFrom-Json
        if ($item.reason -ne 'compiler-artifact') { continue }
        if ($item.profile.test -ne $true -or $item.target.name -cne 'helvichantier_lib' -or [string]::IsNullOrWhiteSpace([string]$item.executable)) { continue }
        if (-not [string]::Equals([IO.Path]::GetFullPath([string]$item.target.src_path), $expectedSource, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Cargo selected a library test from a different source file.'
        }
        $executable = [IO.Path]::GetFullPath([string]$item.executable)
        if (-not [string]::Equals([IO.Path]::GetDirectoryName($executable), $deps, [StringComparison]::OrdinalIgnoreCase) `
            -or [IO.Path]::GetFileName($executable) -cnotmatch '^helvichantier_lib-[0-9a-f]{16}\.exe$') {
            throw 'The test executable is outside the exact release/deps harness scope.'
        }
        $file = Get-Item -LiteralPath $executable
        if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'The selected test harness must be an ordinary file.'
        }
        $selected += $file.FullName
    }
    $selected = @($selected | Select-Object -Unique)
    if ($selected.Count -ne 1) { throw 'Cargo must identify exactly one compiled library test harness.' }
    return $selected[0]
}

function Read-ZentraHarnessManifest {
    param([AllowNull()][string]$Manifest)
    if ($null -ne $Manifest -and $Manifest.Length -gt 262144) { throw 'The test harness manifest is unexpectedly large.' }
    if ([string]::IsNullOrWhiteSpace($Manifest)) { return $null }
    if ($Manifest -match '<!DOCTYPE') { throw 'A test harness manifest must not contain a DTD.' }
    $document = [Xml.XmlDocument]::new()
    $document.XmlResolver = $null
    $document.PreserveWhitespace = $true
    $document.LoadXml($Manifest)
    if ($document.DocumentElement.LocalName -cne 'assembly' -or $document.DocumentElement.NamespaceURI -cne 'urn:schemas-microsoft-com:asm.v1') {
        throw 'The extracted test harness manifest has an unexpected assembly root.'
    }
    return ,$document
}

function Test-ZentraCommonControlsV6 {
    param([AllowNull()][string]$Manifest)
    $document = Read-ZentraHarnessManifest $Manifest
    if ($null -eq $document) { return $false }
    $manager = [Xml.XmlNamespaceManager]::new($document.NameTable)
    $manager.AddNamespace('asm', 'urn:schemas-microsoft-com:asm.v1')
    return $null -ne $document.SelectSingleNode("//asm:dependency/asm:dependentAssembly/asm:assemblyIdentity[@name='Microsoft.Windows.Common-Controls' and @version='6.0.0.0']", $manager)
}

function New-ZentraCommonControlsManifest {
    param([AllowNull()][string]$ExistingManifest)
    $document = Read-ZentraHarnessManifest $ExistingManifest
    if ($null -eq $document) {
        $document = Read-ZentraHarnessManifest '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><assemblyIdentity type="win32" name="Zentra.Verification.Harness" version="1.0.0.0" processorArchitecture="amd64" /></assembly>'
    }
    # The caller writes UTF-8 bytes, even when mt extracted a UTF-16 manifest.
    foreach ($node in $document.ChildNodes) {
        if ($node -is [Xml.XmlDeclaration]) { $node.Encoding = 'utf-8' }
    }
    $manager = [Xml.XmlNamespaceManager]::new($document.NameTable)
    $manager.AddNamespace('asm', 'urn:schemas-microsoft-com:asm.v1')
    $controls = @($document.SelectNodes("//asm:dependency/asm:dependentAssembly/asm:assemblyIdentity[@name='Microsoft.Windows.Common-Controls']", $manager))
    if ($controls.Count -gt 0) {
        if ($controls.Count -ne 1 -or $controls[0].GetAttribute('version') -cne '6.0.0.0') {
            throw 'Do not overwrite an existing incompatible CommonControls manifest dependency.'
        }
        return $document.OuterXml
    }
    $dependency = $document.CreateElement('dependency', $document.DocumentElement.NamespaceURI)
    $dependent = $document.CreateElement('dependentAssembly', $document.DocumentElement.NamespaceURI)
    $identity = $document.CreateElement('assemblyIdentity', $document.DocumentElement.NamespaceURI)
    foreach ($attribute in @{type='win32';name='Microsoft.Windows.Common-Controls';version='6.0.0.0';processorArchitecture='*';publicKeyToken='6595b64144ccf1df';language='*'}.GetEnumerator()) {
        $identity.SetAttribute($attribute.Key, $attribute.Value)
    }
    [void]$dependent.AppendChild($identity)
    [void]$dependency.AppendChild($dependent)
    [void]$document.DocumentElement.AppendChild($dependency)
    return $document.OuterXml
}

function Get-ZentraCommonControlsImports {
    param([string]$Imports)
    return @([regex]::Matches($Imports, '\b(GetWindowSubclass|SetWindowSubclass|RemoveWindowSubclass|DefSubclassProc|TaskDialogIndirect)\b') | ForEach-Object { $_.Value } | Sort-Object -Unique)
}

function Test-ZentraAbsentHarnessManifest {
    param([string]$ToolOutput)
    $absentResource = $ToolOutput -match 'resource (type|name|data|language).*(cannot be found|not found)|resource.*(does not exist|cannot be found)'
    # SDK 10.0.26100 reports a different absence when the PE has no resource
    # section at all. Require the exact SDK code and message on one error line;
    # permissions, invalid PE and missing files must remain failures.
    $absentSection = [regex]::IsMatch($ToolOutput, '(?m)^mt\.exe : general error c101008c: [^\r\n]*The specified image file did not contain a resource section\.[\r]*$')
    return $absentResource -or $absentSection
}

function Find-ZentraHarnessTools {
    $programFiles = [Environment]::GetFolderPath('ProgramFilesX86')
    $dumpbin = Get-Command dumpbin.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $dumpbinPath = if ($null -ne $dumpbin) { $dumpbin.Source } else { $null }
    if ($null -eq $dumpbinPath) {
        $vswhere = Join-Path $programFiles 'Microsoft Visual Studio/Installer/vswhere.exe'
        if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { throw 'The installed Microsoft Visual Studio locator is unavailable.' }
        $dumpbinPath = @(& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\dumpbin.exe') | Select-Object -First 1
        if ($LASTEXITCODE -ne 0) { throw 'Could not locate the installed MSVC dumpbin tool.' }
    }
    $mt = Get-Command mt.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $mtPath = if ($null -ne $mt) { $mt.Source } else { $null }
    if ($null -eq $mtPath) {
        $sdkBin = Join-Path $programFiles 'Windows Kits/10/bin'
        foreach ($version in @(Get-ChildItem -LiteralPath $sdkBin -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } | Sort-Object { [version]$_.Name } -Descending)) {
            $candidate = Join-Path $version.FullName 'x64/mt.exe'
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $mtPath = $candidate; break }
        }
    }
    foreach ($tool in @($dumpbinPath, $mtPath)) {
        if ([string]::IsNullOrWhiteSpace([string]$tool) -or -not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw 'The installed Microsoft PE/manifest tools are unavailable.' }
    }
    $dumpbinPath = Select-ZentraHarnessApplication @([pscustomobject]@{Source=$dumpbinPath})
    $mtPath = Select-ZentraHarnessApplication @([pscustomobject]@{Source=$mtPath})
    return [pscustomobject]@{Dumpbin=$dumpbinPath;Manifest=$mtPath}
}

function Save-ZentraHarnessProof {
    param($Proof, [string]$Path)
    [IO.File]::WriteAllText($Path, ($Proof | ConvertTo-Json -Depth 9), [Text.UTF8Encoding]::new($false))
}

function Initialize-ZentraVerificationHarness {
    param([string]$Repository, [string]$Artifacts, [string]$Source,
        [ValidateSet('diagnostics-verification','release-preflight')][string]$Mode = 'diagnostics-verification')
    Assert-ZentraVerificationMode $Source $Mode $Repository
    $proofPath = Join-Path $Artifacts 'windows-test-harness-proof.json'
    $proof = [ordered]@{source=$Source;verificationOnly=$true;contextMode=$Mode;nativeProfile='release';target='x86_64-pc-windows-msvc';
        originalReleaseCallProfile = if ($Mode -ceq 'release-preflight') { 'debug' } else { $null };
        compileNoRun=$true;applicationManifestModified=$false;dllModified=$false;publishesInstaller=$false;publishesRelease=$false;installsApplication=$false;
        testOnlyManifestTransformation=$false;loaderHypothesis='CommonControls v6 activation missing from the library test harness';loaderHypothesisConfirmed=$false;
        harnessManifestRepairValidated=$false;specificMissingDllOrSymbolConfirmed=$false;
        compileExit=$null;executable=$null;binarySha256Before=$null;binarySha256After=$null;manifestSha256Before=$null;manifestSha256After=$null;
        embeddedV6Before=$false;embeddedV6After=$false;commonControlsImports=@();missingImportsInSystem32=@();loaderExitBefore=$null;loaderExitAfter=$null;
        suiteExecutions=@();prepared=$false}
    try {
        # Get-Command may return multiple applications from different PATH
        # entries. Never cast the entire Source array to a combined file name.
        $cargoCandidates = @(Get-Command cargo -CommandType Application -ErrorAction SilentlyContinue)
        $cargoMetadata = @(Get-ZentraHarnessApplicationMetadata $cargoCandidates)
        $cargoCandidate = if ($cargoMetadata.Count -gt 0) { $cargoMetadata[0].Source } else { $null }
        $proof.compileTool = [ordered]@{name='cargo';candidates=$cargoMetadata;selectedCandidate=$cargoCandidate;
            selected=$null;exists=$false;ordinaryFile=$false;
            workingDirectory=$Repository;workingDirectoryExists=(Test-Path -LiteralPath $Repository -PathType Container)}
        Save-ZentraHarnessProof $proof $proofPath
        if (-not $proof.compileTool.workingDirectoryExists) { throw 'The verification working directory does not exist.' }
        # Rustup proxy links depend on argv0. Ask the installed vendor for the
        # real cargo belonging to the exact toolchain used above; never execute
        # a renamed/resolved rustup target as if it were cargo.
        $rustupCandidates = @(Get-Command rustup -CommandType Application -ErrorAction SilentlyContinue)
        $cargo = Resolve-ZentraToolchainCargo $rustupCandidates $env:RUSTUP_TOOLCHAIN $Repository $Artifacts $proof $proofPath -Mode $Mode
        $jsonPath = Join-Path $Artifacts 'windows-test-harness-cargo.jsonl'
        $buildLog = Join-Path $Artifacts 'windows-test-harness-build.log'
        $compileArguments = @('test','--manifest-path','desktop/src-tauri/Cargo.toml','--locked','--release','--lib','--no-run','--message-format=json')
        if ($Mode -ceq 'release-preflight') { $compileArguments += @('--target','x86_64-pc-windows-msvc') }
        $proof.compileArguments = $compileArguments
        $proof.compileExit = Invoke-ZentraHarnessTool $cargo $compileArguments $Repository $jsonPath $buildLog -HeartbeatMessage 'Compiling the library test harness; no packaging or installation.' -TimeoutSeconds 5400 -Mode $Mode
        Get-Content -LiteralPath $buildLog | ForEach-Object { Write-Host $_ }
        if ($proof.compileExit -ne 0) { throw 'The verification-only library harness did not compile.' }
        $executable = Select-ZentraLibraryHarness $Repository (Get-Content -LiteralPath $jsonPath) -Mode $Mode
        $proof.executable = $executable
        $proof.binarySha256Before = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
        $tools = Find-ZentraHarnessTools
        $os = Get-CimInstance -ClassName Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture
        $proof.os = $os
        $proof.tools = @($tools.Dumpbin, $tools.Manifest) | ForEach-Object { $file=Get-Item -LiteralPath $_; [ordered]@{path=$file.FullName;version=$file.VersionInfo.FileVersion;sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()} }
        $importsPath = Join-Path $Artifacts 'windows-test-harness-imports.txt'
        if ((Invoke-ZentraHarnessTool $tools.Dumpbin @('/IMPORTS',$executable) $Repository $importsPath (Join-Path $Artifacts 'windows-test-harness-imports-errors.txt') -Mode $Mode) -ne 0) { throw 'Could not inspect the exact library harness PE imports.' }
        if ((Invoke-ZentraHarnessTool $tools.Dumpbin @('/DEPENDENTS',$executable) $Repository (Join-Path $Artifacts 'windows-test-harness-dependents.txt') (Join-Path $Artifacts 'windows-test-harness-dependents-errors.txt') -Mode $Mode) -ne 0) { throw 'Could not inspect the exact library harness PE dependencies.' }
        $proof.commonControlsImports = @(Get-ZentraCommonControlsImports ([IO.File]::ReadAllText($importsPath)))
        $systemDll = Join-Path $env:SystemRoot 'System32/comctl32.dll'
        $dll = Get-Item -LiteralPath $systemDll
        $proof.systemCommonControls = [ordered]@{path=$dll.FullName;version=$dll.VersionInfo.FileVersion;sha256=(Get-FileHash -LiteralPath $systemDll -Algorithm SHA256).Hash.ToLowerInvariant()}
        $exportsPath = Join-Path $Artifacts 'windows-system-common-controls-exports.txt'
        if ((Invoke-ZentraHarnessTool $tools.Dumpbin @('/EXPORTS',$systemDll) $Repository $exportsPath (Join-Path $Artifacts 'windows-system-common-controls-errors.txt') -Mode $Mode) -ne 0) { throw 'Could not inspect the system CommonControls export table.' }
        $exports = [IO.File]::ReadAllText($exportsPath)
        $proof.missingImportsInSystem32 = @($proof.commonControlsImports | Where-Object { $exports -notmatch ('\b' + [regex]::Escape($_) + '\b') })
        $beforeManifestPath = Join-Path $Artifacts 'windows-test-harness-manifest-before.xml'
        $manifestErrorPath = Join-Path $Artifacts 'windows-test-harness-manifest-before-errors.txt'
        $extractExit = Invoke-ZentraHarnessTool $tools.Manifest @("-inputresource:$executable;#1","-out:$beforeManifestPath") $Repository (Join-Path $Artifacts 'windows-test-harness-manifest-before-tool.txt') $manifestErrorPath -Mode $Mode
        $proof.manifestExtractionExit = $extractExit
        $existingManifest = $null
        if ($extractExit -eq 0) {
            $existingManifest = [IO.File]::ReadAllText($beforeManifestPath)
            $proof.manifestSha256Before = (Get-FileHash -LiteralPath $beforeManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
            $proof.embeddedV6Before = Test-ZentraCommonControlsV6 $existingManifest
        } else {
            $extractError = [IO.File]::ReadAllText($manifestErrorPath) + [IO.File]::ReadAllText((Join-Path $Artifacts 'windows-test-harness-manifest-before-tool.txt'))
            if (-not (Test-ZentraAbsentHarnessManifest $extractError)) { throw 'The manifest extraction failed without proving an absent embedded manifest.' }
        }
        $listPath = Join-Path $Artifacts 'windows-test-harness-list-before.txt'
        $proof.loaderExitBefore = Invoke-ZentraHarnessTool $executable @('--list') $Repository $listPath (Join-Path $Artifacts 'windows-test-harness-list-before-errors.txt') -Mode $Mode
        if ($proof.loaderExitBefore -eq -1073741511) {
            if ($proof.embeddedV6Before -or $proof.commonControlsImports.Count -eq 0) { throw 'The loader failure does not match a missing v6 harness manifest with retained CommonControls imports.' }
            $mergedPath = Join-Path $Artifacts 'windows-test-harness-manifest-merged.xml'
            [IO.File]::WriteAllText($mergedPath, (New-ZentraCommonControlsManifest $existingManifest), [Text.UTF8Encoding]::new($false))
            Assert-ZentraVerificationMode $Source $Mode $Repository
            if ((Invoke-ZentraHarnessTool $tools.Manifest @('-manifest',$mergedPath,"-outputresource:$executable;#1") $Repository (Join-Path $Artifacts 'windows-test-harness-manifest-embed-tool.txt') (Join-Path $Artifacts 'windows-test-harness-manifest-embed-errors.txt') -Mode $Mode) -ne 0) { throw 'Could not embed the v6 dependency into the disposable library harness.' }
            $proof.testOnlyManifestTransformation = $true
        } elseif ($proof.loaderExitBefore -ne 0) { throw 'The original library harness failed with a different loader or process status.' }
        $afterManifestPath = Join-Path $Artifacts 'windows-test-harness-manifest-after.xml'
        $afterExit = Invoke-ZentraHarnessTool $tools.Manifest @("-inputresource:$executable;#1","-out:$afterManifestPath") $Repository (Join-Path $Artifacts 'windows-test-harness-manifest-after-tool.txt') (Join-Path $Artifacts 'windows-test-harness-manifest-after-errors.txt') -Mode $Mode
        if ($afterExit -eq 0) {
            $proof.manifestSha256After = (Get-FileHash -LiteralPath $afterManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
            $proof.embeddedV6After = Test-ZentraCommonControlsV6 ([IO.File]::ReadAllText($afterManifestPath))
        } elseif ($proof.testOnlyManifestTransformation) { throw 'The transformed harness manifest could not be re-extracted.' }
        if ($proof.testOnlyManifestTransformation -and -not $proof.embeddedV6After) { throw 'The transformed harness did not retain its v6 dependency.' }
        $proof.binarySha256After = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
        $afterListPath = Join-Path $Artifacts 'windows-test-harness-list-after.txt'
        $proof.loaderExitAfter = Invoke-ZentraHarnessTool $executable @('--list') $Repository $afterListPath (Join-Path $Artifacts 'windows-test-harness-list-after-errors.txt') -Mode $Mode
        if ($proof.loaderExitAfter -ne 0) { throw 'The prepared library harness still cannot load; the hypothesis remains unconfirmed.' }
        $testNames = @(Get-Content -LiteralPath $afterListPath | ForEach-Object { if ($_ -match '^([A-Za-z_][A-Za-z0-9_:]*): test$') { $Matches[1] } })
        if ($testNames.Count -eq 0 -or @($testNames | Where-Object { $_.StartsWith('diagnostics::') }).Count -eq 0) { throw 'The prepared library harness did not list the expected native tests.' }
        $proof.loaderHypothesisConfirmed = $proof.testOnlyManifestTransformation -and $proof.loaderExitBefore -eq -1073741511 -and $proof.loaderExitAfter -eq 0
        $proof.harnessManifestRepairValidated = $proof.loaderHypothesisConfirmed
        $proof.loaderDiagnosisLimit = 'A successful resource-only repair supports the activation cause; static imports/exports do not identify the exact failing loaded DLL/symbol.'
        $proof.prepared = $true
        return [pscustomobject]@{Mode=$Mode;Executable=$executable;ExpectedSha256=$proof.binarySha256After;Source=$Source;TestNames=$testNames;Proof=$proof;ProofPath=$proofPath;Repository=$Repository;Artifacts=$Artifacts}
    } finally {
        Save-ZentraHarnessProof $proof $proofPath
    }
}

function Invoke-ZentraVerificationSuite {
    param($Harness, [string]$Suite, [string[]]$ExtraArguments = @(),
        [ValidateSet('diagnostics-verification','release-preflight')][string]$Mode = 'diagnostics-verification',
        [switch]$PreserveOriginalTestArguments)
    Assert-ZentraVerificationMode $Harness.Source $Mode $Harness.Repository
    if (($Mode -ceq 'release-preflight') -ne [bool]$PreserveOriginalTestArguments) {
        throw 'Release-preflight must preserve the exact original libtest arguments.'
    }
    if ($Mode -ceq 'release-preflight') {
        $spec = ConvertTo-ZentraReleaseTestInvocation 'cargo' (@('test','--manifest-path','desktop/src-tauri/Cargo.toml','--locked','--lib',$Suite,'--') + $ExtraArguments)
        if ($Harness.Mode -cne $Mode) { throw 'The prepared harness belongs to a different verification mode.' }
    }
    $actualHash = (Get-FileHash -LiteralPath $Harness.Executable -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -cne $Harness.ExpectedSha256) { throw 'The prepared test harness changed after its manifest and source checks.' }
    $names = @($Harness.TestNames | Where-Object { if ($ExtraArguments -contains '--exact') { $_ -ceq $Suite } else { $_.Contains($Suite) } })
    if ($names.Count -eq 0) { throw 'A native verification suite filter would select no tests.' }
    Write-Host "Running verified library harness filter: $Suite"
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $index = $Harness.Proof.suiteExecutions.Count + 1
    $stdout = Join-Path $Harness.Artifacts ("windows-test-suite-{0:D2}.log" -f $index)
    $stderr = Join-Path $Harness.Artifacts ("windows-test-suite-{0:D2}-errors.log" -f $index)
    $nativeArguments = if ($PreserveOriginalTestArguments) { @($Suite) + $ExtraArguments } else { @($Suite, '--test-threads=1') + $ExtraArguments }
    $crashObservation=$null
    if (Test-ZentraCrashObservationSelection $Suite $ExtraArguments $Mode) { $crashObservation=New-ZentraCrashObservation $Harness.Repository }
    if ($null -eq $crashObservation) {
        $exitCode = Invoke-ZentraHarnessTool $Harness.Executable $nativeArguments $Harness.Repository $stdout $stderr -HeartbeatMessage "Native library filter is running: $Suite" -TimeoutSeconds 3600 -Mode $Mode
    } else {
        $exitCode = Invoke-ZentraHarnessTool $Harness.Executable $nativeArguments $Harness.Repository $stdout $stderr -HeartbeatMessage "Native library filter is running: $Suite" -TimeoutSeconds 3600 -Mode $Mode -CrashObservation $crashObservation
    }
    Get-Content -LiteralPath $stdout | ForEach-Object { Write-Host $_ }
    Get-Content -LiteralPath $stderr | ForEach-Object { Write-Host $_ }
    $watch.Stop()
    $result = [regex]::Match([IO.File]::ReadAllText($stdout), 'test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;')
    $passed = if ($result.Success) { [int]$result.Groups[2].Value } else { 0 }
    $failed = if ($result.Success) { [int]$result.Groups[3].Value } else { 0 }
    $ignored = if ($result.Success) { [int]$result.Groups[4].Value } else { 0 }
    $Harness.Proof.suiteExecutions += [ordered]@{filter=$Suite;selectedNames=$names.Count;extraArguments=$ExtraArguments;nativeArguments=$nativeArguments;contextMode=$Mode;exit=$exitCode;durationMs=$watch.ElapsedMilliseconds;passed=$passed;failed=$failed;ignored=$ignored;stdout=[IO.Path]::GetFileName($stdout);stderr=[IO.Path]::GetFileName($stderr)}
    if ($null -ne $crashObservation) { $Harness.Proof.suiteExecutions[-1].crashProgress=Get-ZentraCrashObservationReceipt $crashObservation }
    Save-ZentraHarnessProof $Harness.Proof $Harness.ProofPath
    if ($exitCode -ne 0 -or -not $result.Success -or $passed -eq 0 -or $failed -ne 0 -or $result.Groups[1].Value -cne 'ok') { throw "The native verification harness failed or selected no executable tests for $Suite ($exitCode)." }
    if ($null -ne $crashObservation) {
        try { Assert-ZentraCrashObservationAdmission $crashObservation $Harness.Source }
        finally { $Harness.Proof.suiteExecutions[-1].crashProgress=Get-ZentraCrashObservationReceipt $crashObservation; Save-ZentraHarnessProof $Harness.Proof $Harness.ProofPath }
    }
}
