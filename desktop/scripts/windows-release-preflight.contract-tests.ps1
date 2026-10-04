param(
    [string]$HelperPath = (Join-Path $PSScriptRoot 'windows-verification-harness.ps1'),
    [string]$ReleaseScriptPath = (Join-Path $PSScriptRoot 'cloud-release-windows.ps1')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Run only real helpers/the extracted dispatcher with inert files and closed
# PowerShell doubles. No cargo, mt, dumpbin, product, installer or Node runs.
# The release bootstrap/body is never evaluated; inert fixtures are retained.
. ([ScriptBlock]::Create([IO.File]::ReadAllText($HelperPath)))
function Write-Host { param([Parameter(ValueFromRemainingArguments=$true)][object[]]$Message) }
$script:contractsPassed = 0
function Assert-Contract { param([bool]$Condition,[string]$Name); if (-not $Condition) { throw "Release-preflight contract failed: $Name" }; $script:contractsPassed++ }
function Assert-Throws { param([ScriptBlock]$Action,[string]$Name); $threw=$false; try { & $Action | Out-Null } catch { $threw=$true }; Assert-Contract $threw $Name }
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('zentra-release-preflight-contract-' + [Guid]::NewGuid().ToString('D'))
$savedEnvironment = @{}
$environmentNames = @('ZENTRA_RELEASE_TEST_HARNESS','ZENTRA_VERIFY_DIAGNOSTICS_ONLY','ZENTRA_VERIFY_ONLY','ZENTRA_VERIFY_PDF_ONLY','ZENTRA_VERIFY_UPDATER_ONLY','ZENTRA_VERIFY_BACKUP_ONLY','ZENTRA_VERIFY_REPORTS_ONLY','CIRCLE_SHA1','CIRCLECI','OS','RUSTUP_TOOLCHAIN')
foreach ($name in $environmentNames) { $savedEnvironment[$name]=[Environment]::GetEnvironmentVariable($name,'Process') }
$script:fixtureSource = '1111111111111111111111111111111111111111'
$script:head = $script:fixtureSource
$script:gitExit = 0
$script:gitCalls = 0
function git {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
    $script:gitCalls++
    if (($Arguments -join '|') -cne ('-C|'+$testRoot+'|rev-parse|HEAD')) { throw 'Unknown git fixture request.' }
    $global:LASTEXITCODE=$script:gitExit
    return $script:head
}
function Set-ReleaseFixtureEnvironment {
    $env:ZENTRA_RELEASE_TEST_HARNESS='true';$env:CIRCLECI='true';$env:OS='Windows_NT'
    $env:CIRCLE_SHA1=$script:fixtureSource;$env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
    foreach ($name in $environmentNames | Where-Object { $_ -clike 'ZENTRA_VERIFY_*' }) { [Environment]::SetEnvironmentVariable($name,'false','Process') }
    $script:head=$script:fixtureSource;$script:gitExit=0
}
try {
    [IO.Directory]::CreateDirectory($testRoot) | Out-Null
    Set-ReleaseFixtureEnvironment
    Assert-ZentraVerificationMode $script:fixtureSource 'release-preflight' $testRoot
    Assert-Contract ($script:gitCalls -eq 1) 'release checks HEAD as well as CircleCI revision'
    foreach ($value in @($null,'false','TRUE','1',' true')) {
        $env:ZENTRA_RELEASE_TEST_HARNESS=$value
        Assert-Throws { Assert-ZentraVerificationMode $script:fixtureSource 'release-preflight' $testRoot } 'only exact opt-in true accepted'
    }
    Set-ReleaseFixtureEnvironment
    foreach ($name in @('CIRCLECI','OS','RUSTUP_TOOLCHAIN')) {
        $saved=[Environment]::GetEnvironmentVariable($name,'Process');[Environment]::SetEnvironmentVariable($name,'other','Process')
        Assert-Throws { Assert-ZentraVerificationMode $script:fixtureSource 'release-preflight' $testRoot } 'CI OS and MSVC toolchain closed'
        [Environment]::SetEnvironmentVariable($name,$saved,'Process')
    }
    foreach ($name in $environmentNames | Where-Object { $_ -clike 'ZENTRA_VERIFY_*' }) {
        foreach ($value in @('true','FALSE','other')) {
            [Environment]::SetEnvironmentVariable($name,$value,'Process')
            Assert-Throws { Assert-ZentraVerificationMode $script:fixtureSource 'release-preflight' $testRoot } 'cannot mix verification-only modes'
        }
        [Environment]::SetEnvironmentVariable($name,'false','Process')
    }
    $script:head='2222222222222222222222222222222222222222'
    Assert-Throws { Assert-ZentraVerificationMode $script:fixtureSource 'release-preflight' $testRoot } 'HEAD mismatch refused'
    $script:head=$script:fixtureSource;$script:gitExit=37
    Assert-Throws { Assert-ZentraVerificationMode $script:fixtureSource 'release-preflight' $testRoot } 'failed git refused'
    $script:gitExit=0;$env:CIRCLE_SHA1='2222222222222222222222222222222222222222'
    Assert-Throws { Assert-ZentraVerificationMode $script:fixtureSource 'release-preflight' $testRoot } 'CircleCI mismatch refused'
    Set-ReleaseFixtureEnvironment
    Assert-Throws { Assert-ZentraVerificationMode 'NOT-A-SHA' 'release-preflight' $testRoot } 'noncanonical source refused'
    Assert-Throws { Assert-ZentraVerificationMode $script:fixtureSource 'release-preflight' (Join-Path $testRoot 'absent') } 'missing repository refused'
    Assert-Throws { Assert-ZentraVerificationMode $script:fixtureSource 'diagnostics-verification' $testRoot } 'release flag does not open diagnostics'
    $env:ZENTRA_RELEASE_TEST_HARNESS=$null;$env:ZENTRA_VERIFY_DIAGNOSTICS_ONLY='true';$env:ZENTRA_VERIFY_ONLY='true'
    Assert-ZentraVerificationMode $script:fixtureSource
    Assert-Contract $true 'historical diagnostic mode remains available'
    Set-ReleaseFixtureEnvironment

    $prefix=@('test','--manifest-path','desktop/src-tauri/Cargo.toml','--locked','--lib','company_','--')
    $original=$prefix+@('--nocapture','--test-threads=1')
    $spec=ConvertTo-ZentraReleaseTestInvocation 'cargo' $original
    Assert-Contract ($spec.Filter -ceq 'company_' -and ($spec.TestArguments -join '|') -ceq '--nocapture|--test-threads=1') 'exact original filter/order'
    Assert-Contract (($original -join '|') -ceq (($prefix+@('--nocapture','--test-threads=1')) -join '|')) 'arguments never mutated'
    $ignored=ConvertTo-ZentraReleaseTestInvocation 'cargo' ($prefix+@('--ignored','--exact'))
    Assert-Contract (($ignored.TestArguments -join '|') -ceq '--ignored|--exact') 'ignored exact keeps absent threads default'
    foreach ($program in @('CARGO','cargo.exe','cargo.cmd','C:/tools/cargo.exe','rustup')) { Assert-Throws { ConvertTo-ZentraReleaseTestInvocation $program $original } 'original cargo only' }
    foreach ($index in 0..4) { $bad=[string[]]$original.Clone();$bad[$index]='unknown';Assert-Throws { ConvertTo-ZentraReleaseTestInvocation 'cargo' $bad } 'prefix exact' }
    foreach ($filter in @('','*','company_ --list','../company','--skip','Company-')) { $bad=[string[]]$original.Clone();$bad[5]=$filter;Assert-Throws { ConvertTo-ZentraReleaseTestInvocation 'cargo' $bad } 'unsafe or empty filter refused' }
    $bad=[string[]]$original.Clone();$bad[6]='--release'
    Assert-Throws { ConvertTo-ZentraReleaseTestInvocation 'cargo' $bad } 'separator exact'
    foreach ($tail in @(@('--list'),@('--skip','company_'),@('--test-threads=2'),@('--test-threads=1','--test-threads=1'),@('--nocapture','--nocapture'),@('--ignored'),@('--EXACT'),@('--include-ignored'))) { Assert-Throws { ConvertTo-ZentraReleaseTestInvocation 'cargo' ($prefix+$tail) } 'unknown duplicate or broadened flags refused' }
    Assert-Throws { ConvertTo-ZentraReleaseTestInvocation 'cargo' $prefix } 'empty tail refused'

    $tokens=$null;$errors=$null
    $releaseAst=[System.Management.Automation.Language.Parser]::ParseFile($ReleaseScriptPath,[ref]$tokens,[ref]$errors)
    Assert-Contract (@($errors).Count -eq 0) 'release parses without evaluation'
    $calls=@($releaseAst.FindAll({param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Invoke-Checked' -and $n.CommandElements.Count -ge 2 -and $n.CommandElements[1].Extent.Text -ceq 'cargo'},$true))
    Assert-Contract ($calls.Count -eq 25) 'all 25 historical cargo call sites retained'
    foreach ($call in $calls) {
        $array=$call.CommandElements[2].SubExpression.Statements[0].PipelineElements[0].Expression
        $arguments=@($array.Elements | ForEach-Object {
            if ($_ -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $_.Value }
            elseif ($_ -is [System.Management.Automation.Language.VariableExpressionAst] -and $_.VariablePath.UserPath -ceq 'suite') { 'fixture::suite' }
            else { throw 'Unexpected nonstatic historical argument.' }
        })
        $parsed=ConvertTo-ZentraReleaseTestInvocation 'cargo' $arguments
        Assert-Contract (($parsed.TestArguments -join '|') -ceq (($arguments[7..($arguments.Count-1)]) -join '|')) 'actual historical tail accepted exactly'
    }

    $deps=Join-Path $testRoot 'desktop/src-tauri/target/x86_64-pc-windows-msvc/release/deps'
    [IO.Directory]::CreateDirectory($deps) | Out-Null
    $src=Join-Path $testRoot 'desktop/src-tauri/src/lib.rs'
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($src)) | Out-Null
    [IO.File]::WriteAllText($src,'inert source')
    $exe=Join-Path $deps 'helvichantier_lib-0123456789abcdef.exe'
    [IO.File]::WriteAllText($exe,'inert library test, never executed')
    $json=([ordered]@{reason='compiler-artifact';profile=@{test=$true};target=@{name='helvichantier_lib';src_path=$src};executable=$exe}|ConvertTo-Json -Depth 5 -Compress)
    Assert-Contract ((Select-ZentraLibraryHarness $testRoot @($json) -Mode 'release-preflight') -ceq $exe) 'exact MSVC release deps shared with package target'
    Assert-Throws { Select-ZentraLibraryHarness $testRoot @($json) } 'target not implicitly accepted by diagnostic scope'
    $productJson=([ordered]@{reason='compiler-artifact';profile=@{test=$true};target=@{name='helvichantier_lib';src_path=$src};executable=(Join-Path $testRoot 'desktop/src-tauri/target/x86_64-pc-windows-msvc/release/Zentra.exe')}|ConvertTo-Json -Depth 5 -Compress)
    Assert-Throws { Select-ZentraLibraryHarness $testRoot @($productJson) -Mode 'release-preflight' } 'product never a patchable test harness'

    $script:toolCalls=0;$script:lastArguments=@();$script:mockExit=0
    $script:summary='test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s'
    function Invoke-ZentraHarnessTool {
        param([string]$Program,[string[]]$Arguments,[string]$Repository,[string]$Stdout,[string]$Stderr,[string]$HeartbeatMessage,[int]$TimeoutSeconds,[string]$Mode)
        if ($Program -cne $exe -or $Mode -cne 'release-preflight') { throw 'Fixture cannot run any other executable or mode.' }
        $script:toolCalls++;$script:lastArguments=$Arguments
        [IO.File]::WriteAllText($Stdout,$script:summary);[IO.File]::WriteAllText($Stderr,'')
        return $script:mockExit
    }
    $prepared=[pscustomobject]@{Mode='release-preflight';Source=$script:fixtureSource;Executable=$exe;ExpectedSha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant();TestNames=@('company_::first','company_::second');Proof=[ordered]@{suiteExecutions=@()};ProofPath=(Join-Path $testRoot 'inert-proof.json');Repository=$testRoot;Artifacts=$testRoot}
    Invoke-ZentraVerificationSuite $prepared 'company_' @('--nocapture','--test-threads=1') -Mode 'release-preflight' -PreserveOriginalTestArguments
    Assert-Contract (($script:lastArguments -join '|') -ceq 'company_|--nocapture|--test-threads=1') 'real dispatcher preserves exact original argv'
    Assert-Contract (@($script:lastArguments | Where-Object { $_ -ceq '--test-threads=1' }).Count -eq 1) 'no duplicated thread flag'
    Assert-Contract (($prepared.Proof.suiteExecutions[-1].nativeArguments -join '|') -ceq ($script:lastArguments -join '|')) 'proof records actual libtest argv'
    $before=$script:toolCalls
    Assert-Throws { Invoke-ZentraVerificationSuite $prepared 'missing' @('--test-threads=1') -Mode 'release-preflight' -PreserveOriginalTestArguments } 'empty suite refused before tool'
    Assert-Throws { Invoke-ZentraVerificationSuite $prepared 'company_' @('--test-threads=1') -Mode 'release-preflight' } 'no implicit default argv'
    Assert-Contract ($script:toolCalls -eq $before) 'invalid selection runs no child'
    $prepared.ExpectedSha256='0000'
    Assert-Throws { Invoke-ZentraVerificationSuite $prepared 'company_' @('--test-threads=1') -Mode 'release-preflight' -PreserveOriginalTestArguments } 'changed library hash refused'
    $prepared.ExpectedSha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    foreach ($result in @(@('test result: ok. 0 passed; 0 failed; 2 ignored;',0),@('test result: FAILED. 1 passed; 1 failed; 0 ignored;',0),@('test result: ok. 2 passed; 0 failed; 0 ignored;',37))) {
        $script:summary=$result[0];$script:mockExit=$result[1]
        Assert-Throws { Invoke-ZentraVerificationSuite $prepared 'company_' @('--test-threads=1') -Mode 'release-preflight' -PreserveOriginalTestArguments } 'zero passed failure or nonzero exit cannot authorize release'
    }
    $script:mockExit=0;$script:summary='test result: ok. 2 passed; 0 failed; 0 ignored;'
    # Run only this real production function; cold initializer is not mocked
    # into a claim of compilation, and no release-body command is evaluated.
    $dispatch=@($releaseAst.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Invoke-Checked'},$true))
    Assert-Contract ($dispatch.Count -eq 1) 'one actual release dispatcher'
    . ([ScriptBlock]::Create($dispatch[0].Extent.Text))
    $script:releasePreflightEnabled=$true;$script:releasePreflightHarness=$prepared
    $repo=$testRoot;$artifacts=$testRoot
    Invoke-Checked cargo $original
    Assert-Contract (($script:lastArguments -join '|') -ceq 'company_|--nocapture|--test-threads=1') 'actual Invoke-Checked routes exact invocation'
    $before=$script:toolCalls
    foreach ($program in @('CARGO','cargo.exe','cargo.cmd','C:/tools/cargo.exe')) { Assert-Throws { Invoke-Checked $program $original } 'cargo aliases cannot fall back to raw tests' }
    $script:releasePreflightHarness=$null
    Assert-Throws { Invoke-Checked cargo ($prefix+@('--list')) } 'unknown shape refused before cold setup'
    Assert-Contract ($script:toolCalls -eq $before) 'unknown calls neither prepare nor execute native process'
    Write-Output "Windows release-preflight contracts: $script:contractsPassed passed; no release script or native executable invoked; inert fixtures retained at $testRoot."
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name,$savedEnvironment[$name],'Process') }
}
