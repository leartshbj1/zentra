param(
    [string]$ReleaseScriptPath = (Join-Path $PSScriptRoot 'cloud-release-windows.ps1'),
    [string]$CircleConfigPath = (Join-Path $PSScriptRoot '../../.circleci/config.yml')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Source/AST contracts only: do not evaluate or dot-source the release script,
# prepare a harness, launch a child process, or write a verification proof.
$script:contractsPassed = 0
function Assert-Contract {
    param([bool]$Condition, [string]$Name)
    if (-not $Condition) { throw "Diagnostics selection contract failed: $Name" }
    $script:contractsPassed++
}
function Normalize-ContractText {
    param([string]$Text)
    return [regex]::Replace($Text.Trim(), '\s+', ' ')
}
function Find-Assignment {
    param([System.Management.Automation.Language.Ast]$Ast, [string]$Name)
    $matches = @($Ast.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
        $node.Operator -eq [System.Management.Automation.Language.TokenKind]::Equals -and
        $node.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
        $node.Left.VariablePath.UserPath -ceq $Name
    }, $true))
    Assert-Contract ($matches.Count -eq 1) "one assignment for $Name"
    return $matches[0]
}
function Read-StaticHashEntry {
    param([System.Management.Automation.Language.HashtableAst]$Table, [string]$Name)
    $matches = @($Table.KeyValuePairs | Where-Object { $_.Item1.Value -ceq $Name })
    Assert-Contract ($matches.Count -eq 1) "one proof entry for $Name"
    return Normalize-ContractText $matches[0].Item2.Extent.Text
}

$tokens = $null
$parseErrors = $null
$releaseAst = [System.Management.Automation.Language.Parser]::ParseFile($ReleaseScriptPath, [ref]$tokens, [ref]$parseErrors)
Assert-Contract (@($parseErrors).Count -eq 0) 'release script parses without execution'
$releaseText = [IO.File]::ReadAllText($ReleaseScriptPath)
$circleText = [IO.File]::ReadAllText($CircleConfigPath)
$statements = @($releaseAst.EndBlock.Statements)
$selection = Find-Assignment $releaseAst 'diagnosticSelection'
$expectedSelection = @'
$diagnosticSelection = if ([string]::IsNullOrEmpty($env:ZENTRA_DIAGNOSTICS_NATIVE_SET)) {
    'full'
} else {
    $env:ZENTRA_DIAGNOSTICS_NATIVE_SET
}
'@
Assert-Contract ((Normalize-ContractText $selection.Extent.Text) -ceq (Normalize-ContractText $expectedSelection)) 'absent or empty selector defaults to full; supplied selector is not coerced'
Assert-Contract ($statements[3] -eq $selection) 'selection precedes repository/tool/bootstrap operations'

# Exact AST shape makes these policy cases source contracts rather than
# execution of extracted PowerShell or a second implementation of the guard.
$unknownGuard = $statements[4]
$expectedUnknownGuard = @'
if ($diagnosticSelection -cnotin @('full', 'native-mail-payroll', 'benchmark-payment', 'benchmark-public-payment')) {
    throw 'Unknown diagnostics native verification set.'
}
'@
Assert-Contract ((Normalize-ContractText $unknownGuard.Extent.Text) -ceq (Normalize-ContractText $expectedUnknownGuard)) 'unknown selector is rejected before bootstrap'
Assert-Contract ($unknownGuard -is [System.Management.Automation.Language.IfStatementAst] -and $unknownGuard.Clauses[0].Item1.PipelineElements[0].Expression.Operator -eq [System.Management.Automation.Language.TokenKind]::Cnotin) 'case variants cannot opt into any allowlisted selector'
Assert-Contract ($unknownGuard.Clauses[0].Item2.Statements.Count -eq 1 -and $unknownGuard.Clauses[0].Item2.Statements[0] -is [System.Management.Automation.Language.ThrowStatementAst]) 'invalid selector has no fallback or child command'

$modeGuard = $statements[5]
$expectedModeGuard = @'
if ($diagnosticSelection -cne 'full' -and
    ($env:ZENTRA_VERIFY_DIAGNOSTICS_ONLY -cne 'true' -or $env:ZENTRA_VERIFY_ONLY -cne 'true')) {
    throw 'Targeted native verification requires both diagnostics and verification-only guards.'
}
'@
Assert-Contract ((Normalize-ContractText $modeGuard.Extent.Text) -ceq (Normalize-ContractText $expectedModeGuard)) 'all nonfull selectors require both guards exactly true; full preserves the existing mode'
Assert-Contract ($modeGuard.Clauses[0].Item2.Statements.Count -eq 1 -and $modeGuard.Clauses[0].Item2.Statements[0] -is [System.Management.Automation.Language.ThrowStatementAst]) 'missing, false or differently cased guard fails before bootstrap'
Assert-Contract ($statements[6].Left.VariablePath.UserPath -ceq 'diagnosticPhase' -and $statements[10] -is [System.Management.Automation.Language.AssignmentStatementAst] -and $statements[10].Left.VariablePath.UserPath -ceq 'repo') 'both refusal guards precede even repository setup'

$targetedBranches = @($releaseAst.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.IfStatementAst] -and
    (Normalize-ContractText $node.Clauses[0].Item1.Extent.Text) -ceq "`$diagnosticSelection -ceq 'native-mail-payroll'"
}, $true))
Assert-Contract ($targetedBranches.Count -eq 1) 'only one opt-in execution branch'
$targetedBranch = $targetedBranches[0]
$targetedBody = $targetedBranch.Clauses[0].Item2
$targetedStatements = @($targetedBody.Statements)
Assert-Contract ($targetedStatements.Count -eq 5) 'targeted branch contains only allowlist, suites, proof, proof write and return'
$filters = Find-Assignment $targetedBody 'targetedFilters'
$expectedFilters = @'
$targetedFilters = @(
    [pscustomobject]@{ Name = 'outgoing_mail::integration_tests::settings_signature_preservation_tests::'; Arguments = @() },
    [pscustomobject]@{ Name = 'commands::payroll_import_worker_tests::'; Arguments = @() },
    [pscustomobject]@{ Name = 'payroll_import::tests::'; Arguments = @() },
    [pscustomobject]@{ Name = 'outgoing_mail::integration_tests::mail_templates_roundtrip_and_credentials_stay_out_of_business_data'; Arguments = @('--exact') },
    [pscustomobject]@{ Name = 'outgoing_mail::integration_tests::mail_logo_'; Arguments = @() }
)
'@
Assert-Contract ((Normalize-ContractText $filters.Extent.Text) -ceq (Normalize-ContractText $expectedFilters)) 'five static filters only; exact flag only for the template roundtrip; no pipeline-supplied filter/flags'
$expectedLoop = @'
foreach ($filter in $targetedFilters) {
    Invoke-ZentraVerificationSuite $diagnosticHarness $filter.Name $filter.Arguments
}
'@
Assert-Contract ((Normalize-ContractText $targetedStatements[1].Extent.Text) -ceq (Normalize-ContractText $expectedLoop)) 'all selected filters use the existing verified harness with their fixed flags'
$commands = @($targetedBody.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true))
Assert-Contract (@($commands | Where-Object { $_.GetCommandName() -cnotin @('Invoke-ZentraVerificationSuite', 'ForEach-Object', 'Join-Path', 'ConvertTo-Json') }).Count -eq 0) 'no frontend, Cargo bootstrap, benchmark or packaging command in targeted branch'

$proofAssignment = Find-Assignment $targetedBody 'targetedProof'
$proofTables = @($proofAssignment.FindAll({ param($node) $node -is [System.Management.Automation.Language.HashtableAst] }, $true))
Assert-Contract ($proofTables.Count -eq 1) 'one targeted proof map'
$proof = $proofTables[0]
foreach ($entry in @(
    @{ Name = 'source'; Value = '$diagnosticSource' },
    @{ Name = 'circleSource'; Value = '$env:CIRCLE_SHA1' },
    @{ Name = 'selection'; Value = '$diagnosticSelection' },
    @{ Name = 'suiteExecutions'; Value = '$diagnosticHarness.Proof.suiteExecutions' },
    @{ Name = 'nativeHarnessProof'; Value = "'windows-test-harness-proof.json'" },
    @{ Name = 'selectedNativeSuitesPassed'; Value = '$true' },
    @{ Name = 'verificationOnly'; Value = '$true' }
)) {
    Assert-Contract ((Read-StaticHashEntry $proof $entry.Name) -ceq $entry.Value) "targeted proof retains $($entry.Name)"
}
foreach ($name in @('frontendExecuted', 'mobileExecuted', 'frontendBuildExecuted', 'benchmarksExecuted', 'publishesInstaller', 'publishesRelease', 'installsApplication')) {
    Assert-Contract ((Read-StaticHashEntry $proof $name) -ceq '$false') "targeted proof does not claim $name"
}
Assert-Contract (@($proof.KeyValuePairs | Where-Object { $_.Item1.Value -cin @('allCheckedSuitesPassed', 'frontendBuildPassed', 'paymentBenchmarkPassed', 'publicPaymentBenchmarkPassed') }).Count -eq 0) 'targeted proof cannot masquerade as the full validation proof'
$expectedProofWrite = @'
[IO.File]::WriteAllText((Join-Path $artifacts 'diagnostics-native-targeted-proof.json'), ($targetedProof | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
'@
Assert-Contract ((Normalize-ContractText $targetedStatements[3].Extent.Text) -ceq (Normalize-ContractText $expectedProofWrite)) 'distinct proof is written only after every verified suite returns'
Assert-Contract ($targetedStatements[4] -is [System.Management.Automation.Language.ReturnStatementAst] -and $null -eq $targetedStatements[4].Pipeline) 'unconditional return excludes the full path and packaging'
$harnessInit = Find-Assignment $releaseAst 'diagnosticHarness'
$fullSuites = Find-Assignment $releaseAst 'diagnosticNativeSuites'
Assert-Contract ($harnessInit.Extent.EndOffset -lt $targetedBranch.Extent.StartOffset -and $targetedBranch.Extent.EndOffset -lt $fullSuites.Extent.StartOffset) 'targeted mode uses prepared harness and returns before the full mode begins'
$circleGuardOffset = $releaseText.IndexOf("if (`$env:CIRCLE_SHA1 -cne `$diagnosticSource)")
Assert-Contract ($circleGuardOffset -ge 0 -and $circleGuardOffset -lt $harnessInit.Extent.StartOffset -and $releaseText.Contains("`$diagnosticSource -notmatch '^[0-9a-f]{40}$'")) 'exact source SHA is checked before harness preparation'
Assert-Contract ($releaseText.Contains("'diagnostics-validation-proof.json'") -and $releaseText.Contains('database::workspace_payment_projection_tests::benchmark_real_payment_workspace_densities') -and $releaseText.Contains('database::workspace_payment_projection_tests::payment_read_projection_tests::benchmark_public_payment_workspace_densities')) 'full proof and both existing benchmarks remain available'
foreach ($appendix in @(
    "`$diagnosticNativeSuites += @('commands::payroll_import_worker_tests::', 'payroll_import::tests::')",
    "`$diagnosticFrontendSuites += @('src/payrollImportScopeBridge.test.ts', 'src/PayrollImportWizardLifecycle.test.tsx')",
    "`$diagnosticMobileSuites += @('src/payrollImportScopeBridge.test.ts', 'src/PayrollImportWizardLifecycle.test.tsx')"
)) {
    Assert-Contract ($releaseText.Contains($appendix)) 'full mode retains the new payroll coverage appendix'
}

# Separate fixed benchmark selectors; inspect AST only, never execute the script.
$benchmarkBranches = @()
foreach ($spec in @(
    @{ Selection = 'benchmark-payment'; Variable = 'paymentBenchmark'; Filter = 'database::workspace_payment_projection_tests::benchmark_real_payment_workspace_densities'; DataFile = 'payment-workspace-benchmark.json'; ProofFile = 'diagnostics-benchmark-payment-proof.json'; Runs = 12 },
    @{ Selection = 'benchmark-public-payment'; Variable = 'publicPaymentBenchmark'; Filter = 'database::workspace_payment_projection_tests::payment_read_projection_tests::benchmark_public_payment_workspace_densities'; DataFile = 'public-payment-workspace-benchmark.json'; ProofFile = 'diagnostics-benchmark-public-payment-proof.json'; Runs = 6 }
)) {
    $condition = "`$diagnosticSelection -ceq '$($spec.Selection)'"
    $branches = @($releaseAst.FindAll({
        param($node)
        $node -is [System.Management.Automation.Language.IfStatementAst] -and
        (Normalize-ContractText $node.Clauses[0].Item1.Extent.Text) -ceq $condition
    }, $true))
    Assert-Contract ($branches.Count -eq 1) "one fixed branch for $($spec.Selection)"
    $branch = $branches[0]; $body = $branch.Clauses[0].Item2
    $benchmarkBranches += $branch
    Assert-Contract ($harnessInit.Extent.EndOffset -lt $branch.Extent.StartOffset -and $branch.Extent.EndOffset -lt $fullSuites.Extent.StartOffset) 'benchmark uses the verified harness and returns before functional suites'
    $filter = Find-Assignment $body $spec.Variable
    Assert-Contract ((Normalize-ContractText $filter.Right.Extent.Text) -ceq "'$($spec.Filter)'") 'benchmark filter is fixed in source, never supplied by a pipeline'
    $invocations = @($body.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -ceq 'Invoke-ZentraVerificationSuite' }, $true))
    $expectedInvocation = 'Invoke-ZentraVerificationSuite $diagnosticHarness $' + $spec.Variable + " @('--ignored','--exact','--nocapture')"
    Assert-Contract ($invocations.Count -eq 1 -and (Normalize-ContractText $invocations[0].Extent.Text) -ceq $expectedInvocation) 'exactly one unchanged ignored/exact/nocapture benchmark dispatch'
    $benchmarkProofAssignment = Find-Assignment $body 'benchmarkOnlyProof'
    $benchmarkProofTables = @($benchmarkProofAssignment.FindAll({ param($node) $node -is [System.Management.Automation.Language.HashtableAst] }, $true))
    Assert-Contract ($benchmarkProofTables.Count -eq 1) 'one separate benchmark proof'
    $benchmarkProof = $benchmarkProofTables[0]
    foreach ($entry in @(
        @{ Name = 'source'; Value = '$diagnosticSource' },
        @{ Name = 'circleSource'; Value = '$env:CIRCLE_SHA1' },
        @{ Name = 'selection'; Value = '$diagnosticSelection' },
        @{ Name = 'verificationOnly'; Value = '$true' },
        @{ Name = 'suiteExecutions'; Value = '$diagnosticHarness.Proof.suiteExecutions' },
        @{ Name = 'nativeHarnessProof'; Value = "'windows-test-harness-proof.json'" },
        @{ Name = 'benchmarkProof'; Value = "'$($spec.DataFile)'" },
        @{ Name = 'selectedBenchmarkPassed'; Value = '$true' },
        @{ Name = 'benchmarksExecuted'; Value = '$true' }
    )) { Assert-Contract ((Read-StaticHashEntry $benchmarkProof $entry.Name) -ceq $entry.Value) "benchmark proof retains $($entry.Name)" }
    foreach ($name in @('fullFunctionalExecuted', 'frontendExecuted', 'mobileExecuted', 'frontendBuildExecuted', 'publishesInstaller', 'publishesRelease', 'installsApplication')) {
        Assert-Contract ((Read-StaticHashEntry $benchmarkProof $name) -ceq '$false') "benchmark proof does not claim $name"
    }
    Assert-Contract (@($benchmarkProof.KeyValuePairs | Where-Object { $_.Item1.Value -cin @('allCheckedSuitesPassed', 'frontendBuildPassed', 'functionalValidationPassed', 'paymentBenchmarkPassed', 'publicPaymentBenchmarkPassed') }).Count -eq 0) 'benchmark-only proof cannot masquerade as functional or combined success'
    $bodyText = Normalize-ContractText $body.Extent.Text
    Assert-Contract ($bodyText.Contains("`$density.allRetainedValuesEqual -ne `$true") -and $bodyText.Contains("`$density.payments -ne 1024") -and $bodyText.Contains("`$density.runs.Count -ne $($spec.Runs)")) 'benchmark retains parity, payment count and original run count'
    Assert-Contract ($bodyText.Contains('.densities.Count -ne 3') -and $bodyText.Contains('.synthetic -ne $true') -and $bodyText.Contains('.optimized -ne $true')) 'benchmark retains three synthetic optimized densities'
    if ($spec.Selection -ceq 'benchmark-public-payment') {
        Assert-Contract ($bodyText.Contains('$density.publicGetters -ne $true') -and $bodyText.Contains('$density.individualPaymentProofsChecked -ne $true')) 'public benchmark retains public-getter and individual-payment controls'
    }
    $benchmarkCommands = @($body.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true))
    Assert-Contract (@($benchmarkCommands | Where-Object { $_.GetCommandName() -cnotin @('Invoke-ZentraVerificationSuite','Join-Path','Test-Path','Get-Content','ConvertFrom-Json','ConvertTo-Json') }).Count -eq 0) 'benchmark branch has no frontend, build, bootstrap, packaging or arbitrary command'
    $bodyStatements = @($body.Statements)
    Assert-Contract ($bodyStatements[-1] -is [System.Management.Automation.Language.ReturnStatementAst] -and $null -eq $bodyStatements[-1].Pipeline) 'benchmark returns unconditionally before the functional path'
    Assert-Contract ($bodyStatements[-2].Extent.Text.Contains($spec.ProofFile) -and $bodyStatements[-2].Extent.Text.Contains('WriteAllText')) 'benchmark writes its distinct proof only after all controls'
}
Assert-Contract ($benchmarkBranches.Count -eq 2) 'both original benchmarks remain, in two separate explicit selections'
$functionalProofAssignment = Find-Assignment $releaseAst 'diagnosticProof'
$functionalProofTable = @($functionalProofAssignment.FindAll({param($node) $node -is [System.Management.Automation.Language.HashtableAst]},$true))[0]
Assert-Contract ((Read-StaticHashEntry $functionalProofTable 'benchmarksExecuted') -ceq '$false') 'functional full proof explicitly excludes benchmark execution'
Assert-Contract ((Read-StaticHashEntry $functionalProofTable 'functionalValidationPassed') -ceq '$diagnosticAllPhasesSelected') 'only the all phase can claim native, frontend, mobile and build success'
Assert-Contract ((Read-StaticHashEntry $functionalProofTable 'requiredBenchmarkSelections') -ceq "@('benchmark-payment', 'benchmark-public-payment')") 'functional proof names both separately required benchmarks'
Assert-Contract (@($functionalProofTable.KeyValuePairs | Where-Object {$_.Item1.Value -cin @('paymentBenchmarkPassed','publicPaymentBenchmarkPassed','paymentWorkspaceParityPassed','publicPaymentBenchmark')}).Count -eq 0) 'functional proof cannot claim benchmark parity or execution'
foreach ($appendix in @(
    "`$diagnosticNativeSuites += @('commands::attachment_mutation_scope_tests::', 'commands::bank_file_scope_tests::')",
    "`$diagnosticFrontendSuites += @('src/attachmentMutationScope.test.ts', 'src/bankFileMutationBridge.test.ts')",
    "`$diagnosticMobileSuites += @('src/attachmentMutationScope.test.ts', 'src/bankFileMutationBridge.test.ts')"
)) { Assert-Contract ($releaseText.Contains($appendix)) 'functional full retains both new scoped-mutation test appendices' }

$parameter = [regex]::Match($circleText, '(?m)^  diagnostics-native-set:\r?\n    type: enum\r?\n    enum: \[full, native-mail-payroll, benchmark-payment, benchmark-public-payment\]\r?\n    default: full\r?$')
Assert-Contract ($parameter.Success -and [regex]::Matches($circleText, '(?m)^  diagnostics-native-set:').Count -eq 1) 'pipeline enum admits full or three explicit allowlisted opt-ins and defaults full'
$job = [regex]::Match($circleText, '(?ms)^  windows-drafts-diagnostics-tests:\r?\n.*?(?=^  [^ ].*:\r?\n|^workflows:\r?\n|\z)')
Assert-Contract ($job.Success -and $job.Value.Contains('ZENTRA_VERIFY_DIAGNOSTICS_ONLY: "true"') -and $job.Value.Contains('ZENTRA_VERIFY_ONLY: "true"')) 'only diagnostic job supplies both hardcoded guards'
Assert-Contract ($job.Value.Contains('ZENTRA_DIAGNOSTICS_NATIVE_SET: << pipeline.parameters.diagnostics-native-set >>') -and [regex]::Matches($circleText, 'ZENTRA_DIAGNOSTICS_NATIVE_SET:').Count -eq 1 -and [regex]::Matches($circleText, 'pipeline\.parameters\.diagnostics-native-set').Count -eq 3) 'selector is not transmitted to release or installer jobs'
$expectedFunctionalWorkflow = @'
  drafts-errors-diagnostics-verification:
    when:
      and:
        - equal: [codex/drafts-errors-diagnostics-20261001, << pipeline.git.branch >>]
        - not: << pipeline.parameters.release >>
        - equal: [full, << pipeline.parameters.diagnostics-native-set >>]
    jobs:
      - windows-drafts-diagnostics-tests:
          name: windows-drafts-diagnostics-native-tests
          diagnostics-phase: native
      - windows-drafts-diagnostics-tests:
          name: windows-drafts-diagnostics-frontend-tests
          diagnostics-phase: frontend
'@
$expectedTargetedWorkflow = @'
  drafts-errors-diagnostics-targeted-verification:
    when:
      and:
        - equal: [codex/drafts-errors-diagnostics-20261001, << pipeline.git.branch >>]
        - not: << pipeline.parameters.release >>
        - not:
            equal: [full, << pipeline.parameters.diagnostics-native-set >>]
    jobs:
      - windows-drafts-diagnostics-tests
'@
Assert-Contract ((Normalize-ContractText $circleText).Contains((Normalize-ContractText $expectedFunctionalWorkflow)) -and (Normalize-ContractText $circleText).Contains((Normalize-ContractText $expectedTargetedWorkflow))) 'full phases and targeted all retain branch and non-release gates with mutually exclusive closed selections'
Assert-Contract ($releaseText.Contains("& (Join-Path `$PSScriptRoot 'diagnostics-native-selection.contract-tests.ps1')")) 'diagnostic CI invokes these static contracts before harness preparation'
# Phase policy is verified by AST/text only. Never execute an extracted guard,
# bootstrap, suite, harness, release script or proof writer in these tests.
$phaseAssignment = Find-Assignment $releaseAst 'diagnosticPhase'
$expectedPhaseAssignment = @'
$diagnosticPhase = if ([string]::IsNullOrEmpty($env:ZENTRA_DIAGNOSTICS_PHASE)) {
    'all'
} else {
    $env:ZENTRA_DIAGNOSTICS_PHASE
}
'@
Assert-Contract ((Normalize-ContractText $phaseAssignment.Extent.Text) -ceq (Normalize-ContractText $expectedPhaseAssignment)) 'phase defaults all only when absent or empty, with no coercion'
Assert-Contract ($statements[6] -eq $phaseAssignment) 'phase admission occurs before repository or tools'
foreach ($guard in @(
    @{ Index = 7; Text = @'
if ($diagnosticPhase -cnotin @('all', 'native', 'frontend')) {
    throw 'Unknown diagnostics verification phase.'
}
'@ },
    @{ Index = 8; Text = @'
if ($diagnosticPhase -cne 'all' -and
    ($env:ZENTRA_VERIFY_DIAGNOSTICS_ONLY -cne 'true' -or $env:ZENTRA_VERIFY_ONLY -cne 'true')) {
    throw 'Split diagnostics phases require both diagnostics and verification-only guards.'
}
'@ },
    @{ Index = 9; Text = @'
if ($diagnosticPhase -cne 'all' -and $diagnosticSelection -cne 'full') {
    throw 'Targeted native and benchmark selections require the all phase.'
}
'@ }
)) {
    $phaseGuard = $statements[$guard.Index]
    Assert-Contract ((Normalize-ContractText $phaseGuard.Extent.Text) -ceq (Normalize-ContractText $guard.Text)) "exact phase admission guard at $($guard.Index)"
    Assert-Contract ($phaseGuard -is [System.Management.Automation.Language.IfStatementAst] -and $phaseGuard.Clauses[0].Item2.Statements.Count -eq 1 -and $phaseGuard.Clauses[0].Item2.Statements[0] -is [System.Management.Automation.Language.ThrowStatementAst]) 'phase refusal never falls back or runs a command'
    Assert-Contract ($phaseGuard.Extent.EndOffset -lt $statements[10].Extent.StartOffset) 'phase guard precedes repository and all bootstrap operations'
}
function Is-InPhaseGuard {
    param([System.Management.Automation.Language.Ast]$Node, [string]$Condition)
    $ancestor = $Node.Parent
    while ($null -ne $ancestor) {
        if ($ancestor -is [System.Management.Automation.Language.IfStatementAst] -and
            (Normalize-ContractText $ancestor.Clauses[0].Item1.Extent.Text) -ceq $Condition) { return $true }
        $ancestor = $ancestor.Parent
    }
    return $false
}
$nativeCondition = "`$diagnosticPhase -cne 'frontend'"
$frontendCondition = "`$diagnosticPhase -cne 'native'"
$nativeGates = @($releaseAst.FindAll({param($node) $node -is [System.Management.Automation.Language.IfStatementAst] -and (Normalize-ContractText $node.Clauses[0].Item1.Extent.Text) -ceq $nativeCondition}, $true))
$frontendGates = @($releaseAst.FindAll({param($node) $node -is [System.Management.Automation.Language.IfStatementAst] -and (Normalize-ContractText $node.Clauses[0].Item1.Extent.Text) -ceq $frontendCondition}, $true))
Assert-Contract ($nativeGates.Count -eq 3 -and $frontendGates.Count -eq 1) 'three native stage gates and one frontend stage gate'
Assert-Contract (@(@($nativeGates) + @($frontendGates) | Where-Object {$_.Clauses.Count -ne 1 -or $null -ne $_.ElseClause}).Count -eq 0) 'stage gates have no alternate clause that could execute an unselected stage'
Assert-Contract (Is-InPhaseGuard $harnessInit $nativeCondition) 'frontend phase cannot compile or prepare the native harness'
$rustInstall = @($releaseAst.FindAll({param($node) $node -is [System.Management.Automation.Language.CommandAst] -and (Normalize-ContractText $node.Extent.Text) -ceq "Invoke-Checked rustup @('toolchain', 'install', `$env:RUSTUP_TOOLCHAIN, '--profile', 'minimal')"}, $true))
Assert-Contract ($rustInstall.Count -eq 1 -and (Is-InPhaseGuard $rustInstall[0] $nativeCondition)) 'frontend skips rustup installation; all/native retain exact toolchain invocation'
$rustDownload = @($releaseAst.FindAll({param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -ceq 'Invoke-WebRequest' -and $node.Extent.Text.Contains('rustup-init.exe')}, $true))
Assert-Contract ($rustDownload.Count -eq 2 -and @($rustDownload | Where-Object {-not (Is-InPhaseGuard $_ $nativeCondition)}).Count -eq 0) 'frontend cannot download Rustup or its checksum'
$nativeLoop = @($releaseAst.FindAll({param($node) $node -is [System.Management.Automation.Language.ForEachStatementAst] -and (Normalize-ContractText $node.Condition.Extent.Text) -ceq '$diagnosticNativeSuites'}, $true))
$expectedNativeLoop = @'
foreach ($suite in $diagnosticNativeSuites) {
    Invoke-ZentraVerificationSuite $diagnosticHarness $suite
}
'@
Assert-Contract ($nativeLoop.Count -eq 1 -and (Normalize-ContractText $nativeLoop[0].Extent.Text) -ceq (Normalize-ContractText $expectedNativeLoop) -and (Is-InPhaseGuard $nativeLoop[0] $nativeCondition)) 'native suite order and verified invocation unchanged under native/all only'
$frontendGateText = Normalize-ContractText $frontendGates[0].Clauses[0].Item2.Extent.Text
Assert-Contract ($frontendGateText.Contains("`$env:TAURI_ENV_PLATFORM = 'desktop'") -and $frontendGateText.Contains("foreach (`$platform in @('ios', 'android'))")) 'all three frontend platforms execute together under frontend/all'
Assert-Contract ($frontendGateText.Contains("Invoke-Checked pnpm.cmd (@('--dir', 'desktop', 'exec', 'vitest', 'run', '--maxWorkers=2') + `$diagnosticFrontendSuites)") -and $frontendGateText.Contains("Invoke-Checked pnpm.cmd (@('--dir', 'desktop', 'exec', 'vitest', 'run', '--maxWorkers=2') + `$diagnosticMobileSuites)")) 'desktop/mobile suite dispatch and maxWorkers budget retained exactly'
Assert-Contract ($frontendGateText.Contains("Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'build:web')") -and $frontendGateText.Contains('finally') -and $frontendGateText.Contains('Remove-Item Env:TAURI_ENV_PLATFORM -ErrorAction SilentlyContinue') -and $frontendGateText.Contains('$env:TAURI_ENV_PLATFORM = $diagnosticPreviousPlatform')) 'frontend build and platform environment restoration preserved'
foreach ($spec in @(
    @{ Name = 'diagnosticNativeSuites'; Count = 62; OrderedSha256 = '69439461eedcd795551e6705906fa4bb9dc21ca4847a01857ac49a5f3fb040f2'; Appendix = @('company_collaboration::reference_worker_tests', 'company_collaboration::content_version_compat_tests', 'company_collaboration::merge_version_compat_tests', 'cloud_backup::tests') },
    @{ Name = 'diagnosticFrontendSuites'; Count = 132; OrderedSha256 = 'f7ee2f55132a1c444897615023436dbd300dabded8159a5f2e8222c14329efa1'; Appendix = @('src/company-vat-identifier.test.tsx') },
    @{ Name = 'diagnosticMobileSuites'; Count = 104; OrderedSha256 = '07aaf124cdba5c7ba326dc5175d37ed73efa79af4bc93908d77650ba497e4923'; Appendix = @('src/company-vat-identifier.test.tsx') }
)) {
    $assignments = @($releaseAst.FindAll({param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and $node.Left.VariablePath.UserPath -ceq $spec.Name}, $true))
    $suiteNames = @($assignments | ForEach-Object { $_.Right.FindAll({param($node) $node -is [System.Management.Automation.Language.StringConstantExpressionAst]}, $true) | ForEach-Object {$_.Value} })
    $expectedCount = $spec.Count + $spec.Appendix.Count
    Assert-Contract ($suiteNames.Count -eq $expectedCount -and @($suiteNames | Select-Object -Unique).Count -eq $expectedCount) "functional $($spec.Name) retains every original suite and its fixed appendix without duplicates"
    $baselineSuiteNames = @($suiteNames | Select-Object -First $spec.Count)
    $appendixSuiteNames = @($suiteNames | Select-Object -Skip $spec.Count)
    Assert-Contract ([string]::Join("`n", $appendixSuiteNames) -ceq [string]::Join("`n", $spec.Appendix)) "functional $($spec.Name) has only its exact ordered quality appendix"
    $suiteHashAlgorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $orderedSuiteHash = [BitConverter]::ToString($suiteHashAlgorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]::Join("`n", $baselineSuiteNames)))).Replace('-', '').ToLowerInvariant()
    } finally { $suiteHashAlgorithm.Dispose() }
    Assert-Contract ($orderedSuiteHash -ceq $spec.OrderedSha256) "functional $($spec.Name) retains every ordered suite name exactly"
}
foreach ($spec in @(
    @{Name='diagnosticAllPhasesSelected'; Value="$"+'diagnosticAllPhasesSelected = $diagnosticPhase -ceq '+"'all'"},
    @{Name='diagnosticNativeExecuted'; Value="$"+'diagnosticNativeExecuted = $diagnosticPhase -cne '+"'frontend'"},
    @{Name='diagnosticFrontendExecuted'; Value="$"+'diagnosticFrontendExecuted = $diagnosticPhase -cne '+"'native'"}
)) {
    $assignment = Find-Assignment $releaseAst $spec.Name
    Assert-Contract ((Normalize-ContractText $assignment.Extent.Text) -ceq $spec.Value -and $assignment.Extent.StartOffset -gt $frontendGates[0].Extent.EndOffset) 'completion flags computed only after all selected stages return'
}
foreach ($entry in @(
    @{ Name = 'phase'; Value = '$diagnosticPhase' },
    @{ Name = 'verificationOnly'; Value = '$true' },
    @{ Name = 'selectedPhasePassed'; Value = '$true' },
    @{ Name = 'nativeExecuted'; Value = '$diagnosticNativeExecuted' },
    @{ Name = 'frontendExecuted'; Value = '$diagnosticFrontendExecuted' },
    @{ Name = 'mobileExecuted'; Value = '$diagnosticFrontendExecuted' },
    @{ Name = 'frontendBuildExecuted'; Value = '$diagnosticFrontendExecuted' },
    @{ Name = 'allCheckedSuitesPassed'; Value = '$diagnosticAllPhasesSelected' },
    @{ Name = 'frontendBuildPassed'; Value = '$diagnosticFrontendExecuted' },
    @{ Name = 'nativeProfile'; Value = "if (`$diagnosticNativeExecuted) { 'release' } else { `$null }" },
    @{ Name = 'nativeExecution'; Value = "if (`$diagnosticNativeExecuted) { 'compiled-library-harness' } else { `$null }" },
    @{ Name = 'nativeHarnessProof'; Value = "if (`$diagnosticNativeExecuted) { 'windows-test-harness-proof.json' } else { `$null }" },
    @{ Name = 'testOnlyManifestTransformation'; Value = 'if ($diagnosticNativeExecuted) { $diagnosticHarness.Proof.testOnlyManifestTransformation } else { $false }' },
    @{ Name = 'loaderHypothesisConfirmed'; Value = 'if ($diagnosticNativeExecuted) { $diagnosticHarness.Proof.loaderHypothesisConfirmed } else { $false }' },
    @{ Name = 'harnessManifestRepairValidated'; Value = 'if ($diagnosticNativeExecuted) { $diagnosticHarness.Proof.harnessManifestRepairValidated } else { $false }' },
    @{ Name = 'executedNativeSuites'; Value = '@(if ($diagnosticNativeExecuted) { $diagnosticNativeSuites })' },
    @{ Name = 'executedFrontendSuites'; Value = '@(if ($diagnosticFrontendExecuted) { $diagnosticFrontendSuites })' },
    @{ Name = 'executedMobileSuites'; Value = '@(if ($diagnosticFrontendExecuted) { $diagnosticMobileSuites })' },
    @{ Name = 'executedFrontendPlatforms'; Value = "@(if (`$diagnosticFrontendExecuted) { 'desktop'; 'ios'; 'android' })" },
    @{ Name = 'publishesInstaller'; Value = '$false' },
    @{ Name = 'publishesRelease'; Value = '$false' },
    @{ Name = 'installsApplication'; Value = '$false' }
)) { Assert-Contract ((Read-StaticHashEntry $functionalProofTable $entry.Name) -ceq $entry.Value) "phase proof honestly reports $($entry.Name)" }
$phaseProofFile = Find-Assignment $releaseAst 'diagnosticProofFile'
$expectedPhaseProofFile = @'
$diagnosticProofFile = switch -CaseSensitive ($diagnosticPhase) {
    'all' { 'diagnostics-validation-proof.json' }
    'native' { 'diagnostics-native-phase-proof.json' }
    'frontend' { 'diagnostics-frontend-phase-proof.json' }
}
'@
Assert-Contract ((Normalize-ContractText $phaseProofFile.Extent.Text) -ceq (Normalize-ContractText $expectedPhaseProofFile)) 'each closed phase has a distinct proof; all retains the historical filename'
$phaseProofWrite = @'
[IO.File]::WriteAllText((Join-Path $artifacts $diagnosticProofFile), ($diagnosticProof | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
'@
Assert-Contract ($releaseText.Contains($phaseProofWrite.Trim()) -and $phaseProofFile.Extent.StartOffset -gt $functionalProofAssignment.Extent.EndOffset) 'terminal phase proof is written only after all selected stages and completion flags'
Assert-Contract ($job.Value.Contains("enum: [all, native, frontend]") -and $job.Value.Contains('default: all') -and $job.Value.Contains('ZENTRA_DIAGNOSTICS_PHASE: << parameters.diagnostics-phase >>')) 'job uses a closed phase enum with all default'
Assert-Contract ([regex]::Matches($circleText,'ZENTRA_DIAGNOSTICS_PHASE:').Count -eq 1 -and [regex]::Matches($circleText,'parameters\.diagnostics-phase').Count -eq 1) 'phase is not forwarded to packaging or release jobs'
Assert-Contract ($job.Value.Contains('resource_class: windows.medium') -and $job.Value.Contains('image: windows-server-2022-gui:2026.05.1') -and $job.Value.Contains('no_output_timeout: 20m')) 'same resource class, image and output timeout budgets'
Assert-Contract (-not $expectedFunctionalWorkflow.Contains('requires:') -and -not $expectedTargetedWorkflow.Contains('diagnostics-phase:')) 'functional instances run independently; targeted job uses unchanged default all'

Write-Output "Diagnostics native selection: $script:contractsPassed static contracts passed; no release script, native executable or child process executed."
