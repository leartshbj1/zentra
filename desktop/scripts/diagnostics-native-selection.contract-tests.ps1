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
Assert-Contract ($statements[6] -is [System.Management.Automation.Language.AssignmentStatementAst] -and $statements[6].Left.VariablePath.UserPath -ceq 'repo') 'both refusal guards precede even repository setup'

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
Assert-Contract ((Read-StaticHashEntry $functionalProofTable 'functionalValidationPassed') -ceq '$true') 'full functional proof retains native, frontend, mobile and build success'
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
Assert-Contract ($job.Value.Contains('ZENTRA_DIAGNOSTICS_NATIVE_SET: << pipeline.parameters.diagnostics-native-set >>') -and [regex]::Matches($circleText, 'ZENTRA_DIAGNOSTICS_NATIVE_SET:').Count -eq 1 -and [regex]::Matches($circleText, 'pipeline\.parameters\.diagnostics-native-set').Count -eq 1) 'selector is not transmitted to release or installer jobs'
Assert-Contract ([regex]::IsMatch($circleText, '(?ms)^  drafts-errors-diagnostics-verification:\r?\n    when:\r?\n      and:\r?\n        - equal: \[codex/drafts-errors-diagnostics-20261001, << pipeline.git.branch >>\]\r?\n        - not: << pipeline.parameters.release >>\r?\n    jobs:\r?\n      - windows-drafts-diagnostics-tests')) 'targeted selector does not bypass the existing branch and non-release workflow gate'
Assert-Contract ($releaseText.Contains("& (Join-Path `$PSScriptRoot 'diagnostics-native-selection.contract-tests.ps1')")) 'diagnostic CI invokes these static contracts before harness preparation'
Write-Output "Diagnostics native selection: $script:contractsPassed static contracts passed; no release script, native executable or child process executed."
