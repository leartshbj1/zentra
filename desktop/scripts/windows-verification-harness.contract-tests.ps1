param([string]$HelperPath = (Join-Path $PSScriptRoot 'windows-verification-harness.ps1'), [string]$NativeNodePath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# These tests never execute cargo, mt, dumpbin or the fixture executable.
. ([ScriptBlock]::Create([IO.File]::ReadAllText($HelperPath)))
function Write-Host { param([Parameter(ValueFromRemainingArguments=$true)][object[]]$Message) }
$script:contractsPassed = 0
function Assert-Contract { param([bool]$Condition, [string]$Name); if (-not $Condition) { throw "Harness contract failed: $Name" }; $script:contractsPassed++ }
function Assert-Throws { param([ScriptBlock]$Action, [string]$Name); $threw=$false; try { & $Action | Out-Null } catch { $threw=$true }; Assert-Contract $threw $Name }
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('zentra-harness-contract-' + [Guid]::NewGuid().ToString('D'))
$savedEnvironment = @{}
foreach ($name in @('ZENTRA_VERIFY_DIAGNOSTICS_ONLY','ZENTRA_VERIFY_ONLY','CIRCLE_SHA1','PATH')) { $savedEnvironment[$name]=[Environment]::GetEnvironmentVariable($name,'Process') }
try {
    $source='1111111111111111111111111111111111111111'
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
    function Invoke-ZentraHarnessTool {
        param([string]$Program,[string[]]$Arguments,[string]$Repository,[string]$Stdout,[string]$Stderr,[string]$HeartbeatMessage,[int]$TimeoutSeconds)
        $script:toolCalls++
        [IO.File]::WriteAllText($Stdout,$script:mockSummary)
        [IO.File]::WriteAllText($Stderr,'')
        return 0
    }
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
    Write-Output "Windows verification harness contracts: $script:contractsPassed passed; no application executable invoked. Optional child process is inert Node only."
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name,$savedEnvironment[$name],'Process') }
    $resolved=[IO.Path]::GetFullPath($testRoot)
    $parent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($resolved),$parent,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^zentra-harness-contract-[0-9a-f-]{36}$') { throw 'Refusing cleanup outside the exact contract-test directory.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
