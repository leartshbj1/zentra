param([string]$HelperPath = (Join-Path $PSScriptRoot 'windows-verification-harness.ps1'), [string]$NativeNodePath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# These tests never execute cargo, mt, dumpbin or the fixture executable.
. ([ScriptBlock]::Create([IO.File]::ReadAllText($HelperPath)))
$script:progressConsole=[Collections.Generic.List[string]]::new()
function Write-Host { param([Parameter(ValueFromRemainingArguments=$true)][object[]]$Message); $line=$Message -join ' '; if ($line.StartsWith('Recovery progress:')) { $script:progressConsole.Add($line) } }
$script:contractsPassed = 0
$script:outcomeMutationWitnesses=[Collections.Generic.List[object]]::new()
function Assert-Contract { param([bool]$Condition, [string]$Name); if (-not $Condition) { throw "Harness contract failed: $Name" }; $script:contractsPassed++ }
function Assert-Throws { param([ScriptBlock]$Action, [string]$Name); $threw=$false; try { & $Action | Out-Null } catch { $threw=$true }; Assert-Contract $threw $Name }
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('zentra-harness-contract-' + [Guid]::NewGuid().ToString('D'))
$savedEnvironment = @{}
foreach ($name in @('ZENTRA_VERIFY_DIAGNOSTICS_ONLY','ZENTRA_VERIFY_ONLY','CIRCLE_SHA1','PATH','RUSTUP_TOOLCHAIN','ZENTRA_RELEASE_TEST_HARNESS','ZENTRA_RECOVERY_CRASH_PROOF')) { $savedEnvironment[$name]=[Environment]::GetEnvironmentVariable($name,'Process') }
try {
    $source='1111111111111111111111111111111111111111'
    $env:ZENTRA_RELEASE_TEST_HARNESS=$null
    $env:ZENTRA_VERIFY_DIAGNOSTICS_ONLY='false'; $env:ZENTRA_VERIFY_ONLY='true'; $env:CIRCLE_SHA1=$source
    Assert-Throws { Assert-ZentraVerificationMode $source } 'no access outside diagnostics mode'
    $env:ZENTRA_VERIFY_DIAGNOSTICS_ONLY='true'; $env:ZENTRA_VERIFY_ONLY='false'
    Assert-Throws { Assert-ZentraVerificationMode $source } 'no access without verification-only guard'
    $env:ZENTRA_VERIFY_ONLY='true'
    Assert-Throws { Assert-ZentraVerificationMode '2222222222222222222222222222222222222222' } 'source must match CircleCI'
    Assert-ZentraVerificationMode $source
    Assert-Contract $true 'exact source and both guards accepted'

    $deps=Join-Path $testRoot 'desktop/src-tauri/target/release/deps'
    [IO.Directory]::CreateDirectory($deps) | Out-Null
    $src=Join-Path $testRoot 'desktop/src-tauri/src/lib.rs'
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($src)) | Out-Null
    [IO.File]::WriteAllText($src,'fixture source')
    $exe=Join-Path $deps 'helvichantier_lib-0123456789abcdef.exe'
    [IO.File]::WriteAllText($exe,'inert fixture, never executed')
    $cmd = Join-Path $deps 'helvichantier_lib.cmd'
    [IO.File]::WriteAllText($cmd,'inert alternate resolution fixture, never executed')
    $multiCandidates=@([pscustomobject]@{Source=$exe},[pscustomobject]@{Source=$cmd})
    Assert-Contract ((Select-ZentraHarnessApplication $multiCandidates) -ceq $exe) 'select only first application rather than concatenate exe/cmd paths'
    Assert-Contract ((Select-ZentraHarnessApplication @($multiCandidates[1],$multiCandidates[0])) -ceq $cmd) 'preserve application order from PATH'
    Assert-Throws { Select-ZentraHarnessApplication @() } 'reject absent tool resolution'
    Assert-Throws { Select-ZentraHarnessApplication @([pscustomobject]@{Source=$deps}) } 'reject directory as verification tool'
    Assert-Throws { Select-ZentraHarnessApplication @([pscustomobject]@{Source=@($exe,$cmd)}) } 'reject a combined application Source array'
    function Cargo-Artifact { param($Executable=$exe,$ProfileTest=$true,$SourcePath=$src); return ([ordered]@{reason='compiler-artifact';profile=@{test=$ProfileTest};target=@{name='helvichantier_lib';src_path=$SourcePath};executable=$Executable} | ConvertTo-Json -Depth 5 -Compress) }
    $valid=Cargo-Artifact
    Assert-Contract ((Select-ZentraLibraryHarness $testRoot @($valid)) -ceq (Get-Item -LiteralPath $exe).FullName) 'select exact Cargo library test'
    Assert-Contract ((Select-ZentraLibraryHarness $testRoot @('{"reason":"build-finished","success":true}',(Cargo-Artifact -ProfileTest $false),$valid)) -ceq (Get-Item -LiteralPath $exe).FullName) 'ignore production/non-artifact messages'
    Assert-Throws { Select-ZentraLibraryHarness $testRoot @((Cargo-Artifact -Executable (Join-Path $testRoot 'Zentra.exe'))) } 'refuse application executable/outside deps'
    Assert-Throws { Select-ZentraLibraryHarness $testRoot @((Cargo-Artifact -SourcePath (Join-Path $testRoot 'different/lib.rs'))) } 'refuse another library source'
    $second=Join-Path $deps 'helvichantier_lib-abcdef0123456789.exe'
    [IO.File]::WriteAllText($second,'second inert fixture')
    Assert-Throws { Select-ZentraLibraryHarness $testRoot @($valid,(Cargo-Artifact -Executable $second)) } 'refuse ambiguous library harnesses'
    Assert-Throws { Select-ZentraLibraryHarness $testRoot @((Cargo-Artifact -ProfileTest $false)) } 'refuse zero test artifacts'
    Assert-Throws { Select-ZentraLibraryHarness $testRoot @('not Cargo JSON',$valid) } 'refuse malformed compiler output'

    $existing='<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><assemblyIdentity name="Original.Name" version="2.3.4.5" type="win32"/><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>'
    Assert-Contract (-not (Test-ZentraCommonControlsV6 $existing)) 'initial manifest lacks v6'
    $merged=New-ZentraCommonControlsManifest $existing
    Assert-Contract (Test-ZentraCommonControlsV6 $merged) 'merged manifest requests v6'
    Assert-Contract ($merged.Contains('Original.Name') -and $merged.Contains('2.3.4.5') -and $merged.Contains('level="asInvoker"') -and $merged.Contains('uiAccess="false"')) 'preserve existing identity/security manifest'
    Assert-Contract (([regex]::Matches((New-ZentraCommonControlsManifest $merged),'name="Microsoft.Windows.Common-Controls"')).Count -eq 1) 'do not duplicate v6 dependency'
    $utf16='<?xml version="1.0" encoding="utf-16" standalone="yes"?>' + $existing
    $utf8=New-ZentraCommonControlsManifest $utf16
    Assert-Contract ($utf8.Contains('encoding="utf-8"') -and $utf8.Contains('standalone="yes"') -and $utf8.Contains('level="asInvoker"') -and $utf8.Contains('Original.Name')) 'normalize UTF-16 declaration to written UTF-8 while preserving metadata'
    Assert-Contract (Test-ZentraCommonControlsV6 (New-ZentraCommonControlsManifest $null)) 'new isolated harness manifest requests v6'
    Assert-Throws { New-ZentraCommonControlsManifest ($merged.Replace('version="6.0.0.0"','version="5.0.0.0"')) } 'do not overwrite incompatible existing dependency'
    Assert-Throws { New-ZentraCommonControlsManifest '<!DOCTYPE assembly [<!ENTITY x SYSTEM "file:///never-read">]><assembly xmlns="urn:schemas-microsoft-com:asm.v1">&x;</assembly>' } 'refuse DTD/external entities'
    Assert-Throws { New-ZentraCommonControlsManifest '<unrelated />' } 'refuse unexpected XML root'
    Assert-Throws { New-ZentraCommonControlsManifest (' ' * 262145) } 'refuse oversized nonempty manifest'
    $imports=@(Get-ZentraCommonControlsImports 'COMCTL32.dll GetWindowSubclass SetWindowSubclass SetWindowSubclass VirtualProtect')
    Assert-Contract ($imports.Count -eq 2 -and $imports -contains 'GetWindowSubclass' -and $imports -contains 'SetWindowSubclass') 'inspect only relevant retained imports without duplicates'
    Assert-Contract ((ConvertTo-ZentraWindowsArgument 'C:\Program Files\SDK\mt.exe') -ceq '"C:\Program Files\SDK\mt.exe"') 'quote SDK paths with spaces'
    Assert-Contract ((ConvertTo-ZentraWindowsArgument '') -ceq '""') 'quote empty argument'
    Assert-Contract ((ConvertTo-ZentraWindowsArgument 'a"b') -ceq '"a\"b"') 'quote embedded literal quote'
    Assert-Contract ((ConvertTo-ZentraWindowsArgument 'C:\folder with space\') -ceq '"C:\folder with space\\"') 'preserve trailing slash in quoted argument'
    $sdk219=@'
Microsoft (R) Manifest Tool
Copyright (c) Microsoft Corporation.
All rights reserved.

mt.exe : general error c101008c: Failed to read the manifest from the resource of file "\\?\C:\Users\circleci\project\desktop\src-tauri\target\release\deps\helvichantier_lib-c10df31880137f13.exe". The specified image file did not contain a resource section.
'@
    Assert-Contract (Test-ZentraAbsentHarnessManifest $sdk219) 'accept exact stdout SDK 219 absent resource section message'
    Assert-Contract (Test-ZentraAbsentHarnessManifest 'mt.exe : general error c101008c: The specified resource type cannot be found in the image file.') 'preserve existing absent resource type classification'
    Assert-Contract (-not (Test-ZentraAbsentHarnessManifest 'mt.exe : general error c101008c: Access is denied.')) 'reject permissions failure from same SDK error code'
    Assert-Contract (-not (Test-ZentraAbsentHarnessManifest 'mt.exe : general error c101008c: The system cannot find the file specified.')) 'reject missing file failure'
    Assert-Contract (-not (Test-ZentraAbsentHarnessManifest 'mt.exe : general error c101008c: The file is not a valid PE image.')) 'reject non-PE image failure'
    Assert-Contract (-not (Test-ZentraAbsentHarnessManifest 'mt.exe : general error c101008c: Failed to read the manifest because its resource section is invalid.')) 'reject other c101008c reason'
    Assert-Contract (-not (Test-ZentraAbsentHarnessManifest ($sdk219.Replace('c101008c','c101008d')))) 'require exact absent-section SDK error code'
    Assert-Contract (-not (Test-ZentraAbsentHarnessManifest ($sdk219.Replace('The specified image file','the specified image file')))) 'require exact absent-section message'
    Assert-Contract (-not (Test-ZentraAbsentHarnessManifest "mt.exe : general error c101008c: Access is denied.`r`nThe specified image file did not contain a resource section.")) 'do not combine SDK code and unrelated lines into absence proof'

    if (-not [string]::IsNullOrWhiteSpace($NativeNodePath)) {
        $nodeFixture=Join-Path $testRoot 'argument fixture.cjs'
        [IO.File]::WriteAllText($nodeFixture,'console.log(JSON.stringify(process.argv.slice(2))); process.exit(37);')
        $nodeOut=Join-Path $testRoot 'node-out.json'
        $nodeErr=Join-Path $testRoot 'node-errors.txt'
        $arguments=@($nodeFixture,'C:\space folder\harness.exe;#1','literal"quote','C:\folder with space\')
        $nodeExit=Invoke-ZentraHarnessTool $NativeNodePath $arguments $testRoot $nodeOut $nodeErr
        Assert-Contract ($nodeExit -eq 37) 'real Node child exit code retained (WinPS5.1 compatible)'
        $seen=[IO.File]::ReadAllText($nodeOut) | ConvertFrom-Json
        if ($seen.Count -ne 3 -or $seen[0] -cne $arguments[1] -or $seen[1] -cne $arguments[2] -or $seen[2] -cne $arguments[3]) { Write-Output ('Inert Node argument diagnostic: ' + ($seen | ConvertTo-Json -Compress)) }
        Assert-Contract ($seen.Count -eq 3 -and $seen[0] -ceq $arguments[1] -and $seen[1] -ceq $arguments[2] -and $seen[2] -ceq $arguments[3]) 'real child receives literal spaced resource path, semicolon/hash, quote and trailing slash'
        $nodePathDirectory = Join-Path $testRoot 'first PATH application'
        [IO.Directory]::CreateDirectory($nodePathDirectory) | Out-Null
        $nodePathCopy = Join-Path $nodePathDirectory 'node.exe'
        [IO.File]::Copy($NativeNodePath,$nodePathCopy)
        [IO.File]::WriteAllText((Join-Path $nodePathDirectory 'node.cmd'),'inert alternate resolution fixture, never executed')
        $env:PATH=$nodePathDirectory+';'+[IO.Path]::GetDirectoryName($NativeNodePath)+';'+$savedEnvironment['PATH']
        $nodeCandidates=@(Get-Command node -CommandType Application)
        Assert-Contract ($nodeCandidates.Count -ge 2) 'real PATH lookup has multiple exe/cmd candidates'
        Assert-Contract ([string]$nodeCandidates.Source -cne $nodePathCopy) 'former Source array cast is not the chosen executable path'
        $resolvedNode = Select-ZentraHarnessApplication $nodeCandidates
        Assert-Contract ($resolvedNode -ceq $nodePathCopy) 'choose first existing ordinary Node executable from PATH'
        $nodeNameExit=Invoke-ZentraHarnessTool $resolvedNode $arguments $testRoot $nodeOut $nodeErr
        Assert-Contract ($nodeNameExit -eq 37) 'real Node process from multiple PATH candidates retains exit code'
        $seen=[IO.File]::ReadAllText($nodeOut) | ConvertFrom-Json
        Assert-Contract ($seen.Count -eq 3 -and $seen[0] -ceq $arguments[1] -and $seen[1] -ceq $arguments[2] -and $seen[2] -ceq $arguments[3]) 'real Node PATH selection preserves literal arguments'
        $env:PATH=$savedEnvironment['PATH']
    }

    $script:toolCalls=0
    $script:mockSummary='test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s'
    $script:mockExit=0
    $script:lastToolArguments=@()
    $script:observedCrashContexts=0
    $script:crashMock='none'
    function Invoke-ZentraHarnessTool {
        param([string]$Program,[string[]]$Arguments,[string]$Repository,[string]$Stdout,[string]$Stderr,[string]$HeartbeatMessage,[int]$TimeoutSeconds,[string]$Mode,$CrashObservation=$null)
        $script:toolCalls++
        $script:lastToolArguments=$Arguments
        if ($null -ne $CrashObservation) {
            $script:observedCrashContexts++
            Assert-ZentraCrashObservationDispatch $Program $Arguments $Repository $Mode $CrashObservation
            [IO.Directory]::CreateDirectory($CrashObservation.Root) | Out-Null
            $stream=New-ContractProgressStream $CrashObservation
            if ($script:crashMock -ceq 'incomplete') { $stream=$stream.Substring(0,$stream.IndexOf("`n")+1) }
            [IO.File]::WriteAllText((Join-Path $CrashObservation.Root 'progress.jsonl'),$stream,[Text.UTF8Encoding]::new($false))
            Write-ContractOutcomes $CrashObservation $env:CIRCLE_SHA1
            if ($script:crashMock -ceq 'bad-outcomes') { [IO.File]::WriteAllText((Join-Path $CrashObservation.Root 'outcomes.json'),'{}') }
            Update-ZentraCrashObservation $CrashObservation -Terminal
            if ($null -ne $CrashObservation.Stream) { $CrashObservation.Stream.Dispose(); $CrashObservation.Stream=$null }
        }
        [IO.File]::WriteAllText($Stdout,$script:mockSummary)
        [IO.File]::WriteAllText($Stderr,'')
        return $script:mockExit
    }
    $script:mockReparsePath=$null
    function Get-Item {
        param([string]$LiteralPath)
        if ($LiteralPath -ceq $script:mockReparsePath) {
            return [pscustomobject]@{FullName=$LiteralPath;PSIsContainer=$false;Attributes=[IO.FileAttributes]::ReparsePoint;LinkType='SymbolicLink';Target=@('C:\fixture\rustup.exe')}
        }
        return Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath
    }
    $vendorDirectory=Join-Path $testRoot 'installed vendor'
    $toolchainDirectory=Join-Path $testRoot 'selected toolchain'
    [IO.Directory]::CreateDirectory($vendorDirectory) | Out-Null
    [IO.Directory]::CreateDirectory($toolchainDirectory) | Out-Null
    $rustupFixture=Join-Path $vendorDirectory 'rustup.exe'
    $cargoFixture=Join-Path $toolchainDirectory 'cargo.exe'
    [IO.File]::WriteAllText($rustupFixture,'inert vendor fixture, never executed')
    [IO.File]::WriteAllText($cargoFixture,'inert toolchain fixture, never executed')
    $vendorCandidates=@([pscustomobject]@{Name='rustup.exe';Source=$rustupFixture},[pscustomobject]@{Name='rustup.exe';Source=$exe})
    $vendorProof=[ordered]@{source=$source;compileTool=[ordered]@{selected=$null;exists=$false;ordinaryFile=$false}}
    $vendorProofPath=Join-Path $testRoot 'vendor-proof.json'
    $env:RUSTUP_TOOLCHAIN='fixture-x86_64-pc-windows-msvc'
    $script:mockSummary=$cargoFixture+"`r`n"
    $resolvedCargo=Resolve-ZentraToolchainCargo $vendorCandidates $env:RUSTUP_TOOLCHAIN $testRoot $testRoot $vendorProof $vendorProofPath
    Assert-Contract ($resolvedCargo -ceq $cargoFixture) 'resolve exact toolchain cargo from vendor rather than proxy target'
    Assert-Contract (($script:lastToolArguments -join '|') -ceq ('which|cargo|--toolchain|'+$env:RUSTUP_TOOLCHAIN)) 'vendor resolver receives exact existing toolchain without installation'
    Assert-Contract ($vendorProof.compileTool.resolver.selected -ceq $rustupFixture -and $vendorProof.compileTool.resolver.candidates.Count -eq 2) 'record resolver first candidate and all applications without concatenation'
    Assert-Contract ($vendorProof.compileTool.exists -and $vendorProof.compileTool.ordinaryFile -and $vendorProof.compileTool.resolver.exit -eq 0) 'capture successful real-file resolution before compile'
    $beforeResolverFailures=$script:toolCalls
    Assert-Throws { Resolve-ZentraToolchainCargo $vendorCandidates 'other-toolchain' $testRoot $testRoot $vendorProof $vendorProofPath } 'do not change toolchain or fall back to stable'
    Assert-Throws { Resolve-ZentraToolchainCargo @() $env:RUSTUP_TOOLCHAIN $testRoot $testRoot $vendorProof $vendorProofPath } 'do not fall back when vendor is absent'
    Assert-Throws { Resolve-ZentraToolchainCargo @($vendorCandidates[1],$vendorCandidates[0]) $env:RUSTUP_TOOLCHAIN $testRoot $testRoot $vendorProof $vendorProofPath } 'do not skip an invalid first vendor application to arbitrary later candidate'
    Assert-Throws { Resolve-ZentraToolchainCargo $vendorCandidates $env:RUSTUP_TOOLCHAIN (Join-Path $testRoot 'missing directory') $testRoot $vendorProof $vendorProofPath } 'reject absent working directory before resolver'
    Assert-Contract ($script:toolCalls -eq $beforeResolverFailures) 'invalid toolchain/vendor/cwd launches no processes'
    $script:mockExit=23
    Assert-Throws { Resolve-ZentraToolchainCargo $vendorCandidates $env:RUSTUP_TOOLCHAIN $testRoot $testRoot $vendorProof $vendorProofPath } 'nonzero vendor resolver status cannot imply success'
    $script:mockExit=0
    $script:mockSummary=''
    Assert-Throws { Resolve-ZentraToolchainCargo $vendorCandidates $env:RUSTUP_TOOLCHAIN $testRoot $testRoot $vendorProof $vendorProofPath } 'empty vendor output is not a cargo path'
    $script:mockSummary=$cargoFixture+"`r`n"+$exe
    Assert-Throws { Resolve-ZentraToolchainCargo $vendorCandidates $env:RUSTUP_TOOLCHAIN $testRoot $testRoot $vendorProof $vendorProofPath } 'multiple vendor output lines cannot select arbitrary cargo'
    $script:mockSummary='cargo.exe'
    Assert-Throws { Resolve-ZentraToolchainCargo $vendorCandidates $env:RUSTUP_TOOLCHAIN $testRoot $testRoot $vendorProof $vendorProofPath } 'relative vendor cargo path is rejected'
    $script:mockSummary=$rustupFixture
    Assert-Throws { Resolve-ZentraToolchainCargo $vendorCandidates $env:RUSTUP_TOOLCHAIN $testRoot $testRoot $vendorProof $vendorProofPath } 'resolved rustup executable cannot run with cargo argv0'
    $script:mockSummary=Join-Path $testRoot 'missing/cargo.exe'
    Assert-Throws { Resolve-ZentraToolchainCargo $vendorCandidates $env:RUSTUP_TOOLCHAIN $testRoot $testRoot $vendorProof $vendorProofPath } 'resolved cargo must exist as a file'
    $script:mockSummary=$cargoFixture
    $script:mockReparsePath=$cargoFixture
    Assert-Throws { Resolve-ZentraToolchainCargo $vendorCandidates $env:RUSTUP_TOOLCHAIN $testRoot $testRoot $vendorProof $vendorProofPath } 'resolved toolchain cargo reparse is rejected without global guard relaxation'
    $metadata=@(Get-ZentraHarnessApplicationMetadata @([pscustomobject]@{Name='cargo.exe';Source=$cargoFixture}))
    Assert-Contract ($metadata.Count -eq 1 -and $metadata[0].linkType -ceq 'SymbolicLink' -and $metadata[0].target[0] -ceq 'C:\fixture\rustup.exe' -and -not $metadata[0].ordinaryFile) 'record proxy link metadata without launching its target'
    $script:mockReparsePath=$rustupFixture
    Assert-Throws { Resolve-ZentraToolchainCargo $vendorCandidates $env:RUSTUP_TOOLCHAIN $testRoot $testRoot $vendorProof $vendorProofPath } 'vendor resolver itself must remain an ordinary file'
    $script:mockReparsePath=$null
    $script:toolCalls=0
    $script:mockSummary='test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s'
    $env:ZENTRA_VERIFY_ONLY='false'
    Assert-Throws { Initialize-ZentraVerificationHarness $testRoot $testRoot $source } 'initializer stops before any tool outside verification-only mode'
    Assert-Contract ($script:toolCalls -eq 0) 'mode failure launches no child processes'
    $env:ZENTRA_VERIFY_ONLY='true'
    $prepared=[pscustomobject]@{Source=$source;Executable=$exe;ExpectedSha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant();TestNames=@('diagnostics::first','diagnostics::second');Proof=[ordered]@{suiteExecutions=@()};ProofPath=(Join-Path $testRoot 'proof.json');Repository=$testRoot;Artifacts=$testRoot}
    Assert-Throws { Invoke-ZentraVerificationSuite $prepared 'no-matching-test' } 'refuse an empty native filter before execution'
    Assert-Contract ($script:toolCalls -eq 0) 'empty filter launches no child processes'
    $prepared.ExpectedSha256='0000'
    Assert-Throws { Invoke-ZentraVerificationSuite $prepared 'diagnostics' } 'refuse harness modified after preparation'
    Assert-Contract ($script:toolCalls -eq 0) 'changed hash launches no child processes'
    $prepared.ExpectedSha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    $script:mockSummary='test result: ok. 0 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.00s'
    Assert-Throws { Invoke-ZentraVerificationSuite $prepared 'diagnostics' } 'zero executable tests cannot produce success proof'
    $script:mockSummary='test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s'
    Invoke-ZentraVerificationSuite $prepared 'diagnostics'
    Assert-Contract ($prepared.Proof.suiteExecutions[-1].passed -eq 2 -and $prepared.Proof.suiteExecutions[-1].selectedNames -eq 2) 'record actual native result and selected filter count'
    $prepared.TestNames=@('bench::exact','bench::exact_other')
    $script:mockSummary='test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s'
    Invoke-ZentraVerificationSuite $prepared 'bench::exact' @('--ignored','--exact','--nocapture')
    Assert-Contract ($prepared.Proof.suiteExecutions[-1].selectedNames -eq 1 -and $prepared.Proof.suiteExecutions[-1].extraArguments -contains '--ignored') 'explicit benchmark exact/ignored flags retained'
    Assert-Contract ($script:observedCrashContexts -eq 0) 'ordinary filters and ignored benchmarks never observe crash evidence'

    # Closed synthetic streams exercise the real parser/state/I/O observer.
    # They are not native, SQLite, process-kill or production admission proof.
    $script:contractContexts=[Collections.Generic.List[object]]::new()
    $script:crashCaseNumber=0
    function New-ContractObservation {
        $script:crashCaseNumber++
        $repository=Join-Path $testRoot ('observer{0:D3}' -f $script:crashCaseNumber)
        [IO.Directory]::CreateDirectory((Join-Path $repository 'desktop/artifacts/recovery-route-witness')) | Out-Null
        $env:ZENTRA_RECOVERY_CRASH_PROOF=Join-Path $repository 'desktop/artifacts/recovery-route-witness/crash'
        $context=New-ZentraCrashObservation $repository
        $script:contractContexts.Add($context)
        return $context
    }
    function Contract-Line {
        param($Context,[int]$Index)
        $expected=$Context.Expected[$Index]
        $event=[ordered]@{v=1;sequence=$Index+1;caseIndex=$expected.caseIndex;mode=$expected.mode;group=$expected.group;boundary=$expected.boundary;stage=$expected.stage;ordinal=$expected.ordinal;checkpoint=$expected.checkpoint;elapsedMs=$Index+1;proofWriteElapsedMicrosBefore=$Index*100;plannedCases=80;plannedKills=122;completedCases=$expected.completedCases;confirmedKills=$expected.confirmedKills;status=$expected.status;failureCategory=$expected.failureCategory}
        return ($event | ConvertTo-Json -Compress)
    }
    function Add-ContractLine { param($Context,[string]$Line); Add-ZentraCrashProgressLine $Context ([Text.Encoding]::UTF8.GetBytes($Line)) }
    function New-ContractProgressStream {
        param($Context)
        return ((@(for ($index=0; $index -lt 1130; $index++) { Contract-Line $Context $index }) -join "`n")+"`n")
    }
    function Get-ContractOutcomeBytesHash {
        param([string]$Raw)
        $hasher=[Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($hasher.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Raw)))).Replace('-','').ToLowerInvariant() }
        finally { $hasher.Dispose() }
    }
    function New-ContractOutcomeMutation {
        param([string]$Raw,[string]$Source,[string]$Name)
        # Admit only the closed, ordinary eighty-case fixture before selecting
        # lexical targets. Never depend on ConvertTo-Json indentation or spaces.
        Assert-ZentraCrashOutcomeKeys $Raw
        $pattern=$null; $expected=0
        switch ($Name) {
            'duplicate-root' { $pattern='"synthetic"\s*:\s*true\b'; $expected=1 }
            'duplicate-case' { $pattern='"phase"\s*:\s*"intent_published"'; $expected=2 }
            'unicode-duplicate-root' { $pattern='"source"\s*:\s*"'+[regex]::Escape($Source)+'"'; $expected=1 }
            'unicode-duplicate-case' { $pattern='"phase"\s*:\s*"intent_published"'; $expected=2 }
            'unicode-key-root' { $pattern='"source"\s*:'; $expected=1 }
            'unicode-key-case' { $pattern='"phase"\s*:'; $expected=80 }
            'unknown-root' { $pattern='"source"\s*:'; $expected=1 }
            'unknown-case' { $pattern='"phase"\s*:'; $expected=80 }
            'case-alias' { $pattern='"source"\s*:'; $expected=1 }
            'wrong-order' { $pattern='"artifactDirectory"\s*:\s*"c00"'; $expected=1 }
            'false-assertion' { $pattern='"secondCleanReopen"\s*:\s*true\b'; $expected=80 }
            'wrong-source' { $pattern='"source"\s*:\s*"'+[regex]::Escape($Source)+'"'; $expected=1 }
            'wrong-type' { $pattern='"synthetic"\s*:\s*true\b'; $expected=1 }
            'missing-case' { $pattern='(?<prefix>"cases"\s*:\s*)\[[\s\S]*\](?=\s*\}\s*$)'; $expected=1 }
            default { throw 'Unknown controlled outcomes mutation.' }
        }
        $targets=[regex]::Matches($Raw,$pattern,[Text.RegularExpressions.RegexOptions]::CultureInvariant)
        Assert-Contract ($targets.Count -eq $expected) ('outcome mutation exact target count '+$Name)
        $builder=[Text.StringBuilder]::new(); $offset=0
        foreach ($target in $targets) {
            [void]$builder.Append($Raw.Substring($offset,$target.Index-$offset))
            $replacement=switch ($Name) {
                'duplicate-root' { $target.Value+', '+$target.Value }
                'duplicate-case' { $target.Value+', '+$target.Value }
                'unicode-duplicate-root' { $target.Value+', '+$target.Value.Replace('"source"','"s\u006furce"') }
                'unicode-duplicate-case' { $target.Value+', '+$target.Value.Replace('"phase"','"p\u0068ase"') }
                'unicode-key-root' { $target.Value.Replace('"source"','"s\u006furce"') }
                'unicode-key-case' { $target.Value.Replace('"phase"','"p\u0068ase"') }
                'unknown-root' { '"unknown": false, '+$target.Value }
                'unknown-case' { '"unknown": false, '+$target.Value }
                'case-alias' { $target.Value.Replace('"source"','"Source"') }
                'wrong-order' { $target.Value.Replace('"c00"','"c01"') }
                'false-assertion' { $target.Value.Substring(0,$target.Value.Length-4)+'false' }
                'wrong-source' { $target.Value.Replace('"'+$Source+'"','"'+('2'*40)+'"') }
                'wrong-type' { $target.Value.Substring(0,$target.Value.Length-4)+'"true"' }
                'missing-case' { $target.Groups['prefix'].Value+'[]' }
            }
            [void]$builder.Append($replacement)
            $offset=$target.Index+$target.Length
        }
        [void]$builder.Append($Raw.Substring($offset))
        $bad=$builder.ToString(); $beforeHash=Get-ContractOutcomeBytesHash $Raw; $afterHash=Get-ContractOutcomeBytesHash $bad
        Assert-Contract (-not [string]::Equals($Raw,$bad,[StringComparison]::Ordinal) -and $beforeHash -cne $afterHash) ('outcome mutation changes UTF8 bytes '+$Name)
        return [pscustomobject]@{raw=$bad;targetCount=$targets.Count;expectedTargetCount=$expected;beforeSha256=$beforeHash;afterSha256=$afterHash}
    }
    function Convert-ContractOutcomeLayout {
        param([string]$Raw,[string]$Name)
        Assert-ZentraCrashOutcomeKeys $Raw
        $lf=$Raw.Replace("`r`n","`n").Replace("`r","`n")
        $keys='("[A-Za-z_][A-Za-z0-9_]*")\s*:\s*'
        switch ($Name) {
            'one-space-lf' { return [regex]::Replace($lf,$keys,'$1: ') }
            'two-space-lf' { return [regex]::Replace($lf,$keys,'$1:  ') }
            'one-space-crlf' { return ([regex]::Replace($lf,$keys,'$1: ')).Replace("`n","`r`n") }
            'two-space-crlf' { return ([regex]::Replace($lf,$keys,'$1:  ')).Replace("`n","`r`n") }
            'tab-lf' { return [regex]::Replace($lf,$keys,('$1:'+"`t")) }
            'four-space-crlf' { return ([regex]::Replace($lf,$keys,'$1:    ')).Replace("`n","`r`n") }
            'compact' { return (($Raw | ConvertFrom-Json) | ConvertTo-Json -Depth 5 -Compress) }
            default { throw 'Unknown controlled outcomes layout.' }
        }
    }

    function New-ContractOutcomeGrammarMutation {
        param([string]$Raw,[string]$Name)
        Assert-ZentraCrashOutcomeKeys $Raw
        $pattern=switch ($Name) {
            'terminal-object' { '\}\s*$' }
            'missing-terminal' { '\}\s*$' }
            'null-primitive' { '"synthetic"\s*:\s*true\b' }
            'number-primitive' { '"synthetic"\s*:\s*true\b' }
            'invalid-primitive' { '"synthetic"\s*:\s*true\b' }
            'nested-case' { '"cases"\s*:\s*\[' }
            'invalid-escape' { '"source"\s*:\s*"' }
            default { throw 'Unknown controlled outcomes grammar mutation.' }
        }
        $targets=[regex]::Matches($Raw,$pattern,[Text.RegularExpressions.RegexOptions]::CultureInvariant)
        Assert-Contract ($targets.Count -eq 1) ('grammar mutation exact target count '+$Name)
        $target=$targets[0]
        $replacement=switch ($Name) {
            'terminal-object' { $target.Value+'{}' }
            'missing-terminal' { '' }
            'null-primitive' { $target.Value.Substring(0,$target.Value.Length-4)+'null' }
            'number-primitive' { $target.Value.Substring(0,$target.Value.Length-4)+'1' }
            'invalid-primitive' { $target.Value+'x' }
            'nested-case' { $target.Value+'{"nested": {},' }
            'invalid-escape' { $target.Value+'\z' }
        }
        $bad=$Raw.Substring(0,$target.Index)+$replacement+$Raw.Substring($target.Index+$target.Length)
        Assert-Contract (-not [string]::Equals($Raw,$bad,[StringComparison]::Ordinal) -and (Get-ContractOutcomeBytesHash $Raw) -cne (Get-ContractOutcomeBytesHash $bad)) ('grammar mutation changes UTF8 bytes '+$Name)
        return $bad
    }

    function Write-ContractOutcomes {
        param($Context,[string]$Source)
        $cases=@(foreach ($case in (Get-ZentraCrashCatalogue)) {
            $committed=$case.group -eq 1 -and ($case.phase -ceq 'commit_published' -or $case.phase.StartsWith('cleanup_'))
            [ordered]@{phase=$case.phase;recoveryInterrupted=($case.group -eq 2);completeArchive=($case.mode -eq 1);result=if ($committed) {'committed-new-profile'} else {'original-profile'};nativeSqliteValidated=$true;nativeWorkspaceRead=$true;documentBase64Exact=$true;managedLogoBase64Exact=$true;auxiliaryExact=$true;secondCleanReopen=$true;archiveSha256=('0'*64);databaseSha256=('1'*64);artifactDirectory=('c{0:D2}' -f $case.caseIndex)}
        })
        $document=[ordered]@{source=$Source;synthetic=$true;nativeExecution='compiled-library-harness-with-owned-child-kills';packageExecuted=$false;actualTauriIpcExecuted=$false;physicalPowerLossVerified=$false;cases=$cases}
        [IO.File]::WriteAllText((Join-Path $Context.Root 'outcomes.json'),($document | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
    }
    try {
        $catalogue=Get-ZentraCrashCatalogue
        Assert-Contract ($catalogue.Count -eq 80 -and @($catalogue | Where-Object {$_.group -eq 1}).Count -eq 38 -and @($catalogue | Where-Object {$_.group -eq 2}).Count -eq 42) 'exact two modes, nineteen restore and twenty-one rollback cases'
        $context=New-ContractObservation
        Assert-Contract ($context.Expected.Count -eq 1130 -and $context.Expected[-1].completedCases -eq 80 -and $context.Expected[-1].confirmedKills -eq 122) 'complete expected matrix remains 80 cases and 122 confirmed owned kills'
        Update-ZentraCrashObservation $context
        Assert-Contract ($context.Error -eq 0 -and $context.EventCount -eq 0) 'missing initial file remains pending'
        Update-ZentraCrashObservation $context -Terminal
        Assert-Contract ($context.Error -eq 7 -and $context.FinalPolled) 'missing terminal evidence refuses'
        Assert-Throws { Assert-ZentraCrashObservationAdmission $context $source } 'no admission from a missing file'

        foreach ($mutation in @('unknown','duplicate','escaped','alias','nested','negative','float','exponent','string-number','null','NaN')) {
            $context=New-ContractObservation; $line=Contract-Line $context 0
            $line=switch ($mutation) {
                'unknown' { $line.Replace('"v":1','"unknown":1') }
                'duplicate' { $line.Replace('"v":1','"v":1,"v":1') }
                'escaped' { $line.Replace('"v":1','"\u0076":1') }
                'alias' { $line.Replace('"v":1','"V":1') }
                'nested' { $line.Replace('"v":1','"v":{"x":1}') }
                'negative' { $line.Replace('"v":1','"v":-1') }
                'float' { $line.Replace('"v":1','"v":1.0') }
                'exponent' { $line.Replace('"v":1','"v":1e0') }
                'string-number' { $line.Replace('"v":1','"v":"1"') }
                'null' { $line.Replace('"v":1','"v":null') }
                'NaN' { $line.Replace('"v":1','"v":NaN') }
            }
            Add-ContractLine $context $line
            Assert-Contract ($context.Error -eq 3 -and $context.EventCount -eq 0) ('closed canonical syntax refuses '+$mutation)
        }
        foreach ($mutation in @('gap','zero-sequence','early-counter','early-kill','wrong-stage','wrong-case','wrong-mode','wrong-group','wrong-boundary','wrong-ordinal','wrong-checkpoint','passed-too-early','failure-category','over-elapsed','over-cost')) {
            $context=New-ContractObservation; $line=Contract-Line $context 0
            $line=switch ($mutation) {
                'gap' {$line.Replace('"sequence":1','"sequence":2')}
                'zero-sequence' {$line.Replace('"sequence":1','"sequence":0')}
                'early-counter' {$line.Replace('"completedCases":0','"completedCases":1')}
                'early-kill' {$line.Replace('"confirmedKills":0','"confirmedKills":1')}
                'wrong-stage' {$line.Replace('"stage":0','"stage":1')}
                'wrong-case' {$line.Replace('"caseIndex":80','"caseIndex":0')}
                'wrong-mode' {$line.Replace('"mode":0','"mode":3')}
                'wrong-group' {$line.Replace('"group":0','"group":3')}
                'wrong-boundary' {$line.Replace('"boundary":0','"boundary":21')}
                'wrong-ordinal' {$line.Replace('"ordinal":0','"ordinal":2')}
                'wrong-checkpoint' {$line.Replace('"checkpoint":0','"checkpoint":31')}
                'passed-too-early' {$line.Replace('"status":0','"status":1')}
                'failure-category' {$line.Replace('"failureCategory":0','"failureCategory":1')}
                'over-elapsed' {$line.Replace('"elapsedMs":1','"elapsedMs":5400001')}
                'over-cost' {$line.Replace('"proofWriteElapsedMicrosBefore":0','"proofWriteElapsedMicrosBefore":2000')}
            }
            Add-ContractLine $context $line
            Assert-Contract ($context.Error -eq 4 -and $context.EventCount -eq 0) ('closed state refuses '+$mutation)
        }
        $context=New-ContractObservation; Add-ContractLine $context (Contract-Line $context 0); Add-ContractLine $context (Contract-Line $context 0)
        Assert-Contract ($context.Error -eq 4 -and $context.EventCount -eq 1) 'duplicate sequence cannot count twice'
        $context=New-ContractObservation; Add-ContractLine $context (Contract-Line $context 0); Add-ContractLine $context (Contract-Line $context 2)
        Assert-Contract ($context.Error -eq 4) 'skipped case or stage refuses'
        $context=New-ContractObservation; Add-ContractLine $context ((Contract-Line $context 0).Replace('"elapsedMs":1','"elapsedMs":100')); Add-ContractLine $context (Contract-Line $context 1)
        Assert-Contract ($context.Error -eq 4) 'decreasing monotonic elapsed time refuses'
        $context=New-ContractObservation; Add-ContractLine $context ((Contract-Line $context 0).Replace('"proofWriteElapsedMicrosBefore":0','"proofWriteElapsedMicrosBefore":500')); Add-ContractLine $context (Contract-Line $context 1)
        Assert-Contract ($context.Error -eq 4) 'decreasing prior completed writer cost refuses'
        $context=New-ContractObservation; Add-ContractLine $context ('x'*1025)
        Assert-Contract ($context.Error -eq 5) 'per-line bound refuses before parsing'
        $context=New-ContractObservation; $context.EventCount=1280; Add-ContractLine $context (Contract-Line $context 0)
        Assert-Contract ($context.Error -eq 5) 'event count bound refuses before parsing'

        $context=New-ContractObservation
        [IO.Directory]::CreateDirectory($context.Root) | Out-Null
        $path=Join-Path $context.Root 'progress.jsonl'
        $line=Contract-Line $context 0
        [IO.File]::WriteAllText($path,$line.Substring(0,15),[Text.UTF8Encoding]::new($false))
        Update-ZentraCrashObservation $context
        Assert-Contract ($context.EventCount -eq 0 -and $context.Error -eq 0 -and $context.Tail.Count -eq 15) 'split bytes without newline remain pending and undecoded'
        [IO.File]::AppendAllText($path,$line.Substring(15)+"`n",[Text.UTF8Encoding]::new($false))
        Update-ZentraCrashObservation $context
        Assert-Contract ($context.EventCount -eq 1 -and $context.Error -eq 0 -and $context.Tail.Count -eq 0) 'complete split line is consumed exactly once'
        Assert-Throws { New-ZentraCrashObservation $context.Repository } 'pre-existing root is never resumed or overwritten'
        [IO.File]::AppendAllText($path,'{"v":',[Text.UTF8Encoding]::new($false))
        Update-ZentraCrashObservation $context -Terminal
        Assert-Contract ($context.Error -eq 7) 'terminal truncated tail refuses'

        $context=New-ContractObservation; [IO.Directory]::CreateDirectory($context.Root) | Out-Null; $path=Join-Path $context.Root 'progress.jsonl'
        [IO.File]::WriteAllBytes($path,[byte[]]@(123,34,195))
        Update-ZentraCrashObservation $context
        Assert-Contract ($context.Error -eq 0 -and $context.Tail.Count -eq 3) 'incomplete UTF-8 bytes are retained without decoding'
        $writer=[IO.File]::Open($path,[IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)
        try { $writer.Write([byte[]]@(169,34,125,10),0,4) } finally { $writer.Dispose() }
        Update-ZentraCrashObservation $context
        Assert-Contract ($context.Error -eq 3) 'complete non-ASCII line refuses without exposing content'

        $context=New-ContractObservation; [IO.Directory]::CreateDirectory($context.Root) | Out-Null; $path=Join-Path $context.Root 'progress.jsonl'
        [IO.File]::WriteAllText($path,(Contract-Line $context 0)+"`n",[Text.UTF8Encoding]::new($false)); Update-ZentraCrashObservation $context
        $writer=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)
        try { $writer.SetLength(0) } finally { $writer.Dispose() }
        Update-ZentraCrashObservation $context
        Assert-Contract ($context.Error -eq 6) 'observed file shrinkage poisons the context'

        $context=New-ContractObservation; [IO.Directory]::CreateDirectory($context.Root) | Out-Null; $path=Join-Path $context.Root 'progress.jsonl'
        [IO.File]::WriteAllText($path,(Contract-Line $context 0)+"`n",[Text.UTF8Encoding]::new($false)); Update-ZentraCrashObservation $context
        $context.CreationTicks--
        Update-ZentraCrashObservation $context
        Assert-Contract ($context.Error -eq 6) 'observed replacement identity contradiction refuses'

        $context=New-ContractObservation; [IO.Directory]::CreateDirectory($context.Root) | Out-Null
        [IO.File]::WriteAllBytes((Join-Path $context.Root 'progress.jsonl'),[byte[]]::new(2097153)); Update-ZentraCrashObservation $context
        Assert-Contract ($context.Error -eq 5 -and $context.Offset -eq 0) 'oversized file refuses before reading payload'
        $context=New-ContractObservation; [IO.Directory]::CreateDirectory($context.Root) | Out-Null
        [IO.File]::WriteAllText((Join-Path $context.Root 'progress.jsonl'),('x'*1025),[Text.UTF8Encoding]::new($false)); Update-ZentraCrashObservation $context
        Assert-Contract ($context.Error -eq 5) 'bounded partial tail refuses without newline'

        $context=New-ContractObservation
        $env:ZENTRA_RECOVERY_CRASH_PROOF=Join-Path $testRoot 'contradiction'
        Update-ZentraCrashObservation $context
        Assert-Contract ($context.Error -eq 2) 'observer path/I/O fault is retained without throwing to the process wait loop'
        Update-ZentraCrashObservation $context -Terminal
        Assert-Contract ($context.FinalPolled -and $context.Error -eq 2) 'faulted observation still receives terminal polling without clearing failure'

        $context=New-ContractObservation
        Add-ContractLine $context (Contract-Line $context 0)
        $failed=(Contract-Line $context 1).Replace('"stage":1','"stage":14').Replace('"status":0','"status":2').Replace('"failureCategory":0','"failureCategory":1')
        Add-ContractLine $context $failed
        Assert-Contract ($context.TerminalState -eq 2 -and $context.Error -eq 0) 'closed original-unwind failure is terminal and never passed'
        Add-ContractLine $context (Contract-Line $context 2)
        Assert-Contract ($context.Error -eq 4) 'events after terminal failure cannot repair admission'
        $context=New-ContractObservation; Add-ContractLine $context (Contract-Line $context 0)
        $wrongFailure=(Contract-Line $context 1).Replace('"stage":1','"stage":14').Replace('"status":0','"status":2').Replace('"failureCategory":0','"failureCategory":1').Replace('"checkpoint":0','"checkpoint":30')
        Add-ContractLine $context $wrongFailure
        Assert-Contract ($context.Error -eq 4) 'failed events still require the exact ordinal/checkpoint tuple'

        $context=New-ContractObservation; $correctRoot=$env:ZENTRA_RECOVERY_CRASH_PROOF
        $env:ZENTRA_RECOVERY_CRASH_PROOF='relative/crash'
        Assert-Throws { New-ZentraCrashObservation $context.Repository } 'relative evidence root is refused before observation'
        $env:ZENTRA_RECOVERY_CRASH_PROOF=$correctRoot
        $script:mockReparsePath=$context.Root
        Assert-Throws { New-ZentraCrashObservation $context.Repository } 'reparse evidence root is refused even before ordinary file existence'
        $script:mockReparsePath=Join-Path $context.Repository 'desktop'
        Assert-Throws { New-ZentraCrashObservation $context.Repository } 'reparse ancestor is refused'
        $script:mockReparsePath=$null

        $context=New-ContractObservation; $secondContext=New-ZentraCrashObservation $context.Repository; $script:contractContexts.Add($secondContext)
        [IO.Directory]::CreateDirectory($context.Root) | Out-Null; $path=Join-Path $context.Root 'progress.jsonl'
        [IO.File]::WriteAllText($path,(Contract-Line $context 0)+"`n",[Text.UTF8Encoding]::new($false)); Update-ZentraCrashObservation $context
        Assert-Contract ($context.EventCount -eq 1 -and $secondContext.EventCount -eq 0 -and $secondContext.Offset -eq 0 -and $secondContext.Tail.Count -eq 0) 'two contexts do not share mutable offsets, tails or state'
        [IO.File]::AppendAllText($path,(Contract-Line $context 1)+"`n",[Text.UTF8Encoding]::new($false)); Update-ZentraCrashObservation $secondContext
        Assert-Contract ($secondContext.EventCount -eq 2 -and $context.EventCount -eq 1) 'independent reader catches its own complete prefix'

        $context=New-ContractObservation; [IO.Directory]::CreateDirectory($context.Root) | Out-Null
        [IO.File]::WriteAllText((Join-Path $context.Root 'progress.jsonl'),(New-ContractProgressStream $context),[Text.UTF8Encoding]::new($false)); Write-ContractOutcomes $context $source
        Update-ZentraCrashObservation $context -Terminal
        Assert-Contract ($context.Error -eq 0 -and $context.FinalPolled -and $context.TerminalState -eq 1 -and $context.EventCount -eq 1130 -and $context.Last.completedCases -eq 80 -and $context.Last.confirmedKills -eq 122) 'final poll consumes a fast complete matrix with exact coverage'
        Assert-ZentraCrashObservationAdmission $context $source
        Assert-Contract $true 'complete synthetic stream and exact outcomes satisfy additive evidence gate only'
        $outcomesPath=Join-Path $context.Root 'outcomes.json'
        $originalOutcomes=[IO.File]::ReadAllText($outcomesPath)
        $outcomeMutationNames=@('duplicate-root','duplicate-case','unicode-duplicate-root','unicode-duplicate-case','unicode-key-root','unicode-key-case','unknown-root','unknown-case','case-alias','wrong-order','false-assertion','wrong-source','wrong-type','missing-case')
        foreach ($mutation in $outcomeMutationNames) {
            $mutationResult=New-ContractOutcomeMutation $originalOutcomes $source $mutation
            $bad=$mutationResult.raw
            [IO.File]::WriteAllText($outcomesPath,$bad,[Text.UTF8Encoding]::new($false))
            Assert-Throws { Assert-ZentraCrashOutcomes $context $source } ('closed full outcomes refuse '+$mutation)
            if ($mutation -cin @('unicode-duplicate-root','unicode-duplicate-case','duplicate-root','duplicate-case','unknown-root','unknown-case')) {
                $context.Error=0
                Assert-Throws { Assert-ZentraCrashObservationAdmission $context $source } ('final complete synthetic admission refuses '+$mutation)
                Assert-Contract ($context.Error -eq 8) ('final rejection retains closed outcome error '+$mutation)
            }
            $script:outcomeMutationWitnesses.Add([pscustomobject]@{layout='native-serializer';mutation=$mutation;targetCount=$mutationResult.targetCount;expectedTargetCount=$mutationResult.expectedTargetCount;beforeSha256=$mutationResult.beforeSha256;afterSha256=$mutationResult.afterSha256;changed=$true;rejected=$true})
        }
        # Re-run the same fourteen refusals on controlled carriers of the real
        # serializer spacing. The ordinary writer and its success stream stay
        # untouched; compact is only one additional adversarial carrier.
        foreach ($layout in @('one-space-lf','two-space-lf','one-space-crlf','two-space-crlf','tab-lf','four-space-crlf','compact')) {
            $layoutRaw=Convert-ContractOutcomeLayout $originalOutcomes $layout
            [IO.File]::WriteAllText($outcomesPath,$layoutRaw,[Text.UTF8Encoding]::new($false))
            Assert-ZentraCrashOutcomes $context $source
            Assert-Contract $true ('ordinary outcome layout remains accepted '+$layout)
            foreach ($mutation in $outcomeMutationNames) {
                $mutationResult=New-ContractOutcomeMutation $layoutRaw $source $mutation
                [IO.File]::WriteAllText($outcomesPath,$mutationResult.raw,[Text.UTF8Encoding]::new($false))
                Assert-Throws { Assert-ZentraCrashOutcomes $context $source } ('layout '+$layout+' outcomes refuse '+$mutation)
                if ($mutation -cin @('unicode-duplicate-root','unicode-duplicate-case','duplicate-root','duplicate-case','unknown-root','unknown-case')) {
                    $context.Error=0
                    Assert-Throws { Assert-ZentraCrashObservationAdmission $context $source } ('layout '+$layout+' complete admission refuses '+$mutation)
                    Assert-Contract ($context.Error -eq 8) ('layout '+$layout+' rejection retains closed outcome error '+$mutation)
                }
                $script:outcomeMutationWitnesses.Add([pscustomobject]@{layout=$layout;mutation=$mutation;targetCount=$mutationResult.targetCount;expectedTargetCount=$mutationResult.expectedTargetCount;beforeSha256=$mutationResult.beforeSha256;afterSha256=$mutationResult.afterSha256;changed=$true;rejected=$true})
            }
        }
        # Perturbed inputs must fail fixture admission instead of allowing an
        # ineffective or ambiguous mutation to masquerade as a validator test.
        $oneSpace=Convert-ContractOutcomeLayout $originalOutcomes 'one-space-lf'
        $missingTarget=$oneSpace.Replace('"artifactDirectory": "c00"','"artifactDirectory": "c01"')
        Assert-Throws { New-ContractOutcomeMutation $missingTarget $source 'wrong-order' } 'mutation fixture refuses a missing lexical target'
        $ambiguousTarget=$oneSpace.Replace('"artifactDirectory": "c01"','"artifactDirectory": "c00"')
        Assert-Throws { New-ContractOutcomeMutation $ambiguousTarget $source 'wrong-order' } 'mutation fixture refuses an ambiguous lexical target'
        Assert-Throws { New-ContractOutcomeMutation $originalOutcomes ('3'*40) 'wrong-source' } 'mutation fixture refuses wrong source instead of a no-op'
        Assert-Throws { New-ContractOutcomeMutation $originalOutcomes $source 'not-a-mutation' } 'mutation fixture refuses unknown mutation names'
        Assert-Throws { Convert-ContractOutcomeLayout $originalOutcomes 'not-a-layout' } 'mutation fixture refuses unknown layout names'
        Assert-Contract ($script:outcomeMutationWitnesses.Count -eq 112 -and @($script:outcomeMutationWitnesses | Where-Object {-not $_.changed -or -not $_.rejected -or $_.targetCount -ne $_.expectedTargetCount -or $_.beforeSha256 -ceq $_.afterSha256}).Count -eq 0) 'all fourteen mutations have exact changed targets and actual refusals across eight layouts'

        [IO.File]::WriteAllText($outcomesPath,$originalOutcomes,[Text.UTF8Encoding]::new($false))
        $context.Error=0
        $quotedDocument=$originalOutcomes | ConvertFrom-Json
        $quotedDocument.nativeExecution='literal "source": "fake" with \\ and } [ , :'
        $quotedDocument.cases[0].phase='literal "p\u0068ase": "fake" with backslash \\ and newline'+"`n"
        $quotedRaw=$quotedDocument | ConvertTo-Json -Depth 5
        Assert-ZentraCrashOutcomeKeys $quotedRaw
        Assert-Contract $true 'scanner does not treat quoted or escaped value text as object keys'
        [IO.File]::WriteAllText($outcomesPath,$quotedRaw,[Text.UTF8Encoding]::new($false))
        Assert-Throws { Assert-ZentraCrashOutcomes $context $source } 'quoted values pass spelling scan but still fail original semantic result validation'
        foreach ($grammarMutation in @('terminal-object','missing-terminal','null-primitive','number-primitive','invalid-primitive','nested-case','invalid-escape')) {
            $badGrammar=New-ContractOutcomeGrammarMutation $originalOutcomes $grammarMutation
            Assert-Throws { Assert-ZentraCrashOutcomeKeys $badGrammar } 'closed scanner refuses invalid shape, nesting, primitive coercion, escape or terminal tail'
        }
        [IO.File]::WriteAllText($outcomesPath,$originalOutcomes,[Text.UTF8Encoding]::new($false))
        $last=Contract-Line $context 1129; Add-ContractLine $context $last
        Assert-Contract ($context.Error -eq 4) 'data after passed matrix poisons the stream'

        $suite='backup::recovery_crash_tests::native_crash_boundaries_restore_one_complete_profile_before_migration'
        Assert-Contract (Test-ZentraCrashObservationSelection $suite @('--ignored','--exact') 'diagnostics-verification') 'exact opted-in crash suite is selected'
        foreach ($selection in @(@($suite,@('--exact'),'diagnostics-verification'),@($suite,@('--ignored','--exact'),'release-preflight'),@('backup::',@('--ignored','--exact'),'diagnostics-verification'),@($suite,@('--ignored','--exact','--nocapture'),'diagnostics-verification'))) {
            Assert-Contract (-not (Test-ZentraCrashObservationSelection $selection[0] $selection[1] $selection[2])) 'non-exact shape, mode or filter never reads progress'
        }
        $context=New-ContractObservation
        Assert-Throws { Assert-ZentraCrashObservationDispatch $exe @('bench::exact','--test-threads=1','--exact','--ignored') $context.Repository 'diagnostics-verification' $context } 'generic tool cannot dispatch arbitrary observation filter'
        Assert-Throws { Assert-ZentraCrashObservationDispatch 'C:\arbitrary.exe' @($suite,'--test-threads=1','--exact','--ignored') $context.Repository 'diagnostics-verification' $context } 'generic tool cannot observe an arbitrary executable'

        # The existing native-result gate remains conjunctive. Fake evidence
        # cannot override a failing exit; success needs every additive gate.
        $prepared.TestNames=@($suite); $script:mockSummary='test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s'
        foreach ($scenario in @('native-failure','incomplete','bad-outcomes','passed')) {
            $caseContext=New-ContractObservation
            $env:ZENTRA_RECOVERY_CRASH_PROOF=Join-Path $testRoot 'desktop/artifacts/recovery-route-witness/crash'
            $ownedRoot=$env:ZENTRA_RECOVERY_CRASH_PROOF
            if (Test-Path -LiteralPath $ownedRoot) { throw 'Synthetic suite proof must be fresh.' }
            $script:mockExit=if ($scenario -ceq 'native-failure') {23} else {0}
            $script:crashMock=if ($scenario -ceq 'incomplete') {'incomplete'} elseif ($scenario -ceq 'bad-outcomes') {'bad-outcomes'} else {'complete'}
            if ($scenario -ceq 'passed') { Invoke-ZentraVerificationSuite $prepared $suite @('--exact','--ignored'); Assert-Contract ($prepared.Proof.suiteExecutions[-1].crashProgress.completedCases -eq 80 -and $prepared.Proof.suiteExecutions[-1].crashProgress.confirmedKills -eq 122) 'all existing and additive gates retain the complete synthetic result' }
            else { Assert-Throws { Invoke-ZentraVerificationSuite $prepared $suite @('--exact','--ignored') } ('conjunctive admission refuses '+$scenario) }
            $resolvedRoot=[IO.Path]::GetFullPath($ownedRoot)
            $expectedRoot=[IO.Path]::GetFullPath((Join-Path $testRoot 'desktop/artifacts/recovery-route-witness/crash'))
            if (-not [string]::Equals($resolvedRoot,$expectedRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing synthetic cleanup outside exact proof root.' }
            Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
        }
        Assert-Contract ($script:observedCrashContexts -eq 4) 'only four exact synthetic suite invocations attach an observer'
        Assert-Contract ($script:progressConsole.Count -gt 0 -and @($script:progressConsole | Where-Object {$_ -cnotmatch '^Recovery progress: case=[0-9]+/80 kills=[0-9]+/122 stage=[0-9]+ elapsedMs=[0-9]+ priorProofWriteMicros=[0-9]+$'}).Count -eq 0) 'observer console projection contains only accepted fixed numeric fields'
        $tokens=$null; $errors=$null
        $ast=[Management.Automation.Language.Parser]::ParseFile($HelperPath,[ref]$tokens,[ref]$errors)
        Assert-Contract ($errors.Count -eq 0) 'helper parses through the PowerShell AST'
        $toolBody=$ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-ZentraHarnessTool'},$true)[0].Body.Extent.Text
        $waitPosition=$toolBody.IndexOf('while (-not $process.WaitForExit(25000))')
        $timeoutPosition=$toolBody.IndexOf('if ($watch.Elapsed.TotalSeconds -ge $TimeoutSeconds)')
        $observerPosition=$toolBody.IndexOf('Update-ZentraCrashObservation $CrashObservation }')
        $finalPosition=$toolBody.IndexOf('Update-ZentraCrashObservation $CrashObservation -Terminal')
        $exitPosition=$toolBody.IndexOf('$exitCode = $process.ExitCode')
        Assert-Contract ($waitPosition -ge 0 -and $timeoutPosition -gt $waitPosition -and $observerPosition -gt $timeoutPosition -and $finalPosition -gt $observerPosition -and $exitPosition -gt $finalPosition -and $toolBody.Contains('Stop-Process -Id $process.Id -Force') -and $toolBody.Contains('return [int]$exitCode')) 'observer preserves owned process wait, unchanged timeout, final poll and actual native exit handling'
    } finally {
        foreach ($context in $script:contractContexts) { if ($null -ne $context.Stream) { $context.Stream.Dispose(); $context.Stream=$null } }
    }
    Write-Output (([ordered]@{kind='outcomes-layout-witnesses';runtime=$PSVersionTable.PSVersion.ToString();layouts=8;mutations=112;nativeExecuted=$false;witnesses=$script:outcomeMutationWitnesses.ToArray()} | ConvertTo-Json -Depth 6 -Compress))
    Write-Output "Windows verification harness contracts: $script:contractsPassed passed; no application executable invoked. Optional child process is inert Node only."
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name,$savedEnvironment[$name],'Process') }
    $resolved=[IO.Path]::GetFullPath($testRoot)
    $parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($resolved),$parent,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^zentra-harness-contract-[0-9a-f-]{36}$') { throw 'Refusing cleanup outside the exact contract-test directory.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
