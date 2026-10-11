# Pure PS behavior and AST checks only. SYNTHETIC results never attest native
# execution. Rust source is read as text; the CI runner is parsed, never run.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'action-native-profile-verification.ps1')
$script:passed = 0
function Assert-Behavior {
    param([bool]$Condition,[string]$Name)
    if (-not $Condition) { throw "Native profile CI contract failed: $Name" }
    $script:passed++
}
function Assert-Refused {
    param([scriptblock]$Action,[string]$Name)
    $refused = $false
    try { $null = & $Action } catch { $refused = $true }
    Assert-Behavior $refused $Name
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$context = [ordered]@{
    CIRCLECI='true';OS='Windows_NT';CIRCLE_BRANCH='codex/action-engine-native';CIRCLE_SHA1=('a' * 40)
    ZENTRA_VERIFY_DIAGNOSTICS_ONLY='true';ZENTRA_VERIFY_ONLY='true';ZENTRA_VERIFY_NATIVE_PROFILE_ONLY='true'
    ZENTRA_NATIVE_PROFILE_RELEASE='false';ZENTRA_DIAGNOSTICS_NATIVE_SET='action-engine'
    RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc';CARGO_TARGET_DIR=$null
}
$null = Assert-ZentraNativeProfileAdmission $context
Assert-Behavior $true 'exact admission passes without side effects'
foreach ($name in $context.Keys) {
    $copy = [ordered]@{}
    foreach ($key in $context.Keys) { $copy[$key] = $context[$key] }
    $copy[$name] = 'wrong'
    Assert-Refused { Assert-ZentraNativeProfileAdmission $copy } "wrong $name refuses"
    $copy.Remove($name)
    Assert-Refused { Assert-ZentraNativeProfileAdmission $copy } "missing $name refuses"
}
foreach ($value in @('TRUE','True',' true','true ')) {
    $copy = [ordered]@{}
    foreach ($key in $context.Keys) { $copy[$key] = $context[$key] }
    $copy['ZENTRA_VERIFY_NATIVE_PROFILE_ONLY'] = $value
    Assert-Refused { Assert-ZentraNativeProfileAdmission $copy } 'opt-in does not coerce case or whitespace'
}
$json = [IO.File]::ReadAllText((Join-Path $repo 'desktop/tests/fixtures/action-native-test-profile.public.json'))
$shaText = [IO.File]::ReadAllText((Join-Path $repo 'desktop/tests/fixtures/action-native-test-profile.public.sha256'))
$fixture = Get-ZentraNativeProfileFixture $json $shaText
Assert-Behavior ($fixture.Sha256.Length -eq 64 -and $fixture.Json -ceq $json) 'prepared public inputs preserve exact JSON and full SHA'
Assert-Behavior ((Get-ZentraNativeProfileFixture $json ("`n" + $shaText + "`n")).Sha256 -ceq $fixture.Sha256) 'only external LF can be trimmed'
foreach ($bad in @($fixture.Sha256 + "`r`n", ' ' + $fixture.Sha256, $fixture.Sha256 + ' ',
    $fixture.Sha256.ToUpperInvariant(), ([char]0xfeff + $fixture.Sha256), $fixture.Sha256.Substring(0,63), ('0' * 64))) {
    Assert-Refused { Get-ZentraNativeProfileFixture $json $bad } 'nonexact or mismatched full manifest SHA refuses'
}

# Corroborate the reviewed names against source declarations without compiling.
$profileNames = @()
foreach ($spec in @(
    @{File='native_test_profile.rs';Module='tests';Count=18},
    @{File='account_cloud.rs';Module='sandbox_profile_tests';Count=4},
    @{File='license.rs';Module='sandbox_profile_tests';Count=4}
)) {
    $text = [IO.File]::ReadAllText((Join-Path $repo ('desktop/src-tauri/src/' + $spec.File)))
    $start = [regex]::Match($text, '(?m)^mod ' + $spec.Module + ' \{\r?$')
    Assert-Behavior $start.Success "source module $($spec.File) exists"
    $body = $text.Substring($start.Index)
    $end = [regex]::Match($body, '(?m)^\}\r?$')
    Assert-Behavior $end.Success 'source module has an explicit top-level close'
    $body = $body.Substring(0,$end.Index)
    $names = @([regex]::Matches($body, '(?m)^    #\[test\]\r?\n    fn ([a-zA-Z_][a-zA-Z0-9_]*)\(') | ForEach-Object { $_.Groups[1].Value })
    Assert-Behavior ($names.Count -eq $spec.Count -and $body -notmatch '#\[ignore') 'fixed source module count has no ignored tests'
    $prefix = [IO.Path]::GetFileNameWithoutExtension($spec.File) + '::' + $spec.Module + '::'
    $profileNames += @($names | ForEach-Object { $prefix + $_ })
}
$catalogue = @($profileNames + 'diagnostics::tests::synthetic_unselected')
$plan = Get-ZentraNativeProfileVerificationPlan -TestNames $catalogue
Assert-Behavior ($plan.Filters.Count -eq 3 -and $plan.ProfileTestNames.Count -eq 26 -and $plan.ActionEngineTestNames.Count -eq 0) 'three exact modules select all 26 source names only'
Assert-Refused { Get-ZentraNativeProfileVerificationPlan @() } 'empty catalogue refuses'
Assert-Refused { Get-ZentraNativeProfileVerificationPlan @($catalogue + $catalogue[0]) } 'duplicate catalogue refuses'
Assert-Refused { Get-ZentraNativeProfileVerificationPlan @($catalogue + 'invalid name') } 'invalid catalogue refuses'
Assert-Refused { Get-ZentraNativeProfileVerificationPlan @($catalogue + 'native_test_profile::tests::unreviewed') } 'extra module test refuses'
Assert-Refused { Get-ZentraNativeProfileVerificationPlan @($catalogue[1..($catalogue.Count - 1)] + 'native_test_profile::tests::replacement') } 'same-count replacement refuses'
Assert-Refused { Get-ZentraNativeProfileVerificationPlan @($catalogue + ('nested::' + $catalogue[0])) } 'substring collision refuses'
function New-SyntheticEvidence {
    param($Plan)
    $executions = @(); $outputs = @(); $errors = @()
    for ($index=0; $index -lt $Plan.Filters.Count; $index++) {
        $filter = $Plan.Filters[$index]
        $executions += [pscustomobject]@{
            filter=$filter.Name;contextMode='diagnostics-verification';exit=0;failed=0;ignored=0
            selectedNames=$filter.ExpectedCount;passed=$filter.ExpectedCount
            extraArguments=[string[]]@($filter.Arguments)
            nativeArguments=[string[]](@($filter.Name,'--test-threads=1') + @($filter.Arguments))
            stdout=('windows-test-suite-{0:D2}.log' -f ($index + 1));stderr=('windows-test-suite-{0:D2}-errors.log' -f ($index + 1))
        }
        $lines = @("running $($filter.ExpectedCount) tests")
        $lines += @($filter.TestNames | ForEach-Object { "test $_ ... ok" })
        $lines += "test result: ok. $($filter.ExpectedCount) passed; 0 failed; 0 ignored; 0 measured; $($Plan.CatalogueCount - $filter.ExpectedCount) filtered out; finished in 0.01s"
        $outputs += (($lines -join "`n") + "`n`n")
        $errors += ''
    }
    return [pscustomobject]@{Executions=$executions;Outputs=$outputs;Errors=$errors}
}
function Assert-SyntheticEvidence {
    param($Plan,$Evidence)
    Assert-ZentraNativeProfileVerificationProof -Plan $Plan -SuiteExecutions $Evidence.Executions -StdoutTexts $Evidence.Outputs -StderrTexts $Evidence.Errors
}
$evidence = New-SyntheticEvidence $plan
$result = Assert-SyntheticEvidence $plan $evidence
Assert-Behavior ($result.TotalPassed -eq 26 -and $result.ProfilePassed -eq 26 -and $result.RuntimeNamesAndCountsCorroborated) 'synthetic successful raw logs corroborate all exact names'
foreach ($case in @(
    @{Name='nonzero exit';Change={param($e) $e.Executions[0].exit=1}},
    @{Name='failed test';Change={param($e) $e.Executions[0].failed=1}},
    @{Name='ignored test';Change={param($e) $e.Executions[0].ignored=1}},
    @{Name='missing pass';Change={param($e) $e.Executions[0].passed--}},
    @{Name='string counter';Change={param($e) $e.Executions[0].passed='18'}},
    @{Name='wrong selection count';Change={param($e) $e.Executions[0].selectedNames++}},
    @{Name='changed arguments';Change={param($e) $e.Executions[0].extraArguments=@('--ignored')}},
    @{Name='changed native arguments';Change={param($e) $e.Executions[0].nativeArguments+=@('--ignored')}},
    @{Name='wrong filter';Change={param($e) $e.Executions[0].filter='other::'}},
    @{Name='wrong context';Change={param($e) $e.Executions[0].contextMode='release-preflight'}},
    @{Name='foreign stdout path';Change={param($e) $e.Executions[0].stdout='../other.log'}},
    @{Name='foreign stderr path';Change={param($e) $e.Executions[0].stderr='other.log'}},
    @{Name='missing suite';Change={param($e) $e.Executions=@($e.Executions[0..1])}},
    @{Name='missing stdout';Change={param($e) $e.Outputs=@($e.Outputs[0..1])}},
    @{Name='missing stderr';Change={param($e) $e.Errors=@($e.Errors[0..1])}},
    @{Name='duplicate summary';Change={param($e) $e.Outputs[0]+=$e.Outputs[0]}},
    @{Name='replaced raw name';Change={param($e) $e.Outputs[0]=$e.Outputs[0].Replace('actual_server_preparer_fixture_and_complete_hash_are_accepted','same_count_replacement')}},
    @{Name='duplicate raw name';Change={param($e) $e.Outputs[0]=$e.Outputs[0].Replace('absent_compilation_inputs_are_unconfigured_and_partial_inputs_refuse','actual_server_preparer_fixture_and_complete_hash_are_accepted')}},
    @{Name='raw failed row';Change={param($e) $e.Outputs[0]=$e.Outputs[0].Replace(' ... ok',' ... FAILED')}},
    @{Name='trailing ignored row with reason';Change={param($e) $e.Outputs[0]+="test unexpected::case ... ignored, reason`n"}},
    @{Name='nonterminal summary';Change={param($e) $e.Outputs[0]+="unexpected trailing output`n"}},
    @{Name='unexpected stderr';Change={param($e) $e.Errors[0]='unexpected error'}}
)) {
    $changed = New-SyntheticEvidence $plan
    & $case.Change $changed
    Assert-Refused { Assert-SyntheticEvidence $plan $changed } $case.Name
}

# The old plan is reused, not edited. Its selected counts remain 195 + 44.
$actionCounts = [ordered]@{
    'action_engine_resources::tests::'=20;'action_engine_quote::tests::'=67;'action_engine_device_protocol::tests::'=33
    'account_cloud::action_engine::tests::'=29;'backup::action_engine_archive_tests::'=4
    'company_collaboration::action_engine_collaboration_tests::'=3;'company_collaboration::action_publication_tests::'=17
    'company_collaboration::action_execution_tests::'=8;'company_collaboration::publication_recovery_tests::'=13
    'backup::recovery_tests::'=5;'company_collaboration::reference_worker_tests::'=10
    'company_collaboration::content_version_compat_tests::'=7;'company_collaboration::merge_version_compat_tests::'=3
    'backup::recovery_crash_tests::'=19
}
$actionCatalogue = @()
foreach ($prefix in $actionCounts.Keys) { for ($i=0; $i -lt $actionCounts[$prefix]; $i++) { $actionCatalogue += "$($prefix)synthetic_$i" } }
$actionCatalogue += @('company_merge::tests::actual_v60_and_v61_references_merge_v62_branches_receipts_and_republish_fresh_resources',
    'backup::recovery_crash_tests::native_crash_child','backup::recovery_crash_tests::native_crash_boundaries_restore_one_complete_profile_before_migration')
$absentPlan = Get-ZentraNativeProfileVerificationPlan -TestNames @($catalogue + $actionCatalogue) -IncludeActionEngine
$absentResult = Assert-SyntheticEvidence $absentPlan (New-SyntheticEvidence $absentPlan)
Assert-Behavior ($absentPlan.Filters.Count -eq 36 -and $absentPlan.ExpectedTotal -eq 265 -and $absentResult.ActionEnginePassed -eq 239) 'absent context adds unchanged 33-suite 239 selection to the three new modules'
Assert-Behavior (($absentResult.TotalPassed + 2 * $result.TotalPassed) -eq 317) 'separate contexts total 265 plus 26 plus 26'

# Parse the future runner. Never dot-source or invoke it, even with mocks.
$runnerPath = Join-Path $PSScriptRoot 'verify-action-native-profile-windows.ps1'
$tokens=$null; $parseErrors=$null
$runnerAst = [Management.Automation.Language.Parser]::ParseFile($runnerPath,[ref]$tokens,[ref]$parseErrors)
Assert-Behavior ($parseErrors.Count -eq 0) 'runner AST parses without execution'
$calls = @($runnerAst.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst]},$true))
$guard = @($calls | Where-Object {$_.GetCommandName() -ceq 'Assert-ZentraNativeProfileAdmission'})
Assert-Behavior ($guard.Count -eq 1) 'runner has one pure admission guard'
$mutations = @($runnerAst.FindAll({param($n)
    ($n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text.StartsWith('$env:')) -or
    ($n -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Member.Value -cin @('SetEnvironmentVariable','CreateDirectory','WriteAllText')) -or
    ($n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -cin @('Invoke-ZentraHarnessTool','Initialize-ZentraVerificationHarness','Invoke-ZentraVerificationSuite','Save-ZentraHarnessProof'))
},$true))
Assert-Behavior ($mutations.Count -gt 0 -and @($mutations | Where-Object {$_.Extent.StartOffset -lt $guard[0].Extent.EndOffset}).Count -eq 0) 'admission precedes every environment mutation, directory, bootstrap and harness action'
$runnerText = [IO.File]::ReadAllText($runnerPath)
$headGuard = @($runnerAst.FindAll({param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.Contains('HEAD to equal the exact CircleCI source')},$true))
Assert-Behavior ($headGuard.Count -eq 1 -and @($mutations | Where-Object {$_.Extent.StartOffset -lt $headGuard[0].Extent.EndOffset}).Count -eq 0) 'source equality refuses before mutation and bootstrap'
Assert-Behavior (@($calls | Where-Object {$_.GetCommandName() -cin @('cargo','Invoke-WebRequest','Start-Process','cloud-release-windows.ps1','npm','npm.cmd','pnpm','pnpm.cmd')}).Count -eq 0) 'runner has no direct Cargo, HTTP, release or frontend invocation'
Assert-Behavior ($runnerText.Contains("foreach (`$context in @('absent','sandbox','partial'))") -and $runnerText.Contains('-IncludeActionEngine:($context -ceq ''absent'')')) 'only absent context selects legacy tests'
$topTry = @($runnerAst.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})
Assert-Behavior ($topTry.Count -eq 1 -and $null -ne $topTry[0].Finally -and $topTry[0].Finally.Extent.Text.Contains('[Environment]::SetEnvironmentVariable($name,$savedEnvironment[$name],''Process'')')) 'process environment is restored in the outer finally'
Assert-Behavior ($runnerText.Contains('ZENTRA_ACTION_FULL_ARCHIVE_EVIDENCE') -and $runnerText.Contains('fullArchiveInteropExecuted=$false') -and $runnerText.Contains('historicalG0EvidenceModified=$false')) 'new archive export and proof never claim a new ZIP-to-TS execution or rewrite G0'
Assert-Behavior ($runnerText.Contains('[Text.UTF8Encoding]::new($false,$true)') -and $runnerText.Contains('$strictUtf8.GetString([IO.File]::ReadAllBytes($fixtureShaPath))')) 'fixture SHA is decoded from strict original UTF8 bytes without automatic BOM removal'
Write-Host "Native profile CI pure behavior/AST checks passed: $script:passed (nativeExecution=false; CI runner never executed)."
