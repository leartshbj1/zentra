[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Repository,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedSource,
  [Parameter(Mandatory = $true)][string]$SourceSnapshotPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedSnapshotSha256,
  [switch]$IncludeCrashCandidate
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Candidate recipe only. Do not fabricate CI flags or execute it on a workstation.
if ($env:CIRCLECI -cne 'true' -or $env:OS -cne 'Windows_NT') { throw 'Disposable Windows CircleCI runner required.' }
if ($env:CIRCLE_SHA1 -cne $ExpectedSource) { throw 'Exact CircleCI revision required.' }
if ($env:ZENTRA_VERIFY_DIAGNOSTICS_ONLY -cne 'true' -or $env:ZENTRA_VERIFY_ONLY -cne 'true') { throw 'Both existing verification-only guards are required.' }
if ($env:RUSTUP_TOOLCHAIN -cne 'stable-x86_64-pc-windows-msvc') { throw 'The installed MSVC toolchain is required.' }
if (-not [string]::IsNullOrEmpty($env:CARGO_TARGET_DIR)) { throw 'The existing harness requires its exact repository target directory.' }
$repo = (Resolve-Path -LiteralPath $Repository).Path
$head = @(& git -C $repo rev-parse HEAD)
if ($LASTEXITCODE -ne 0 -or $head.Count -ne 1 -or $head[0] -cne $ExpectedSource) { throw 'Repository HEAD must equal the reviewed CircleCI revision.' }
. (Join-Path $repo 'desktop/scripts/recovery-source-integrity.ps1')
$integrityArtifacts = Split-Path -Parent $SourceSnapshotPath
Assert-ZentraRecoverySourceSnapshot $repo $ExpectedSource $SourceSnapshotPath $ExpectedSnapshotSha256 $integrityArtifacts 'before-recovery-harness'
$version = (Get-Content -LiteralPath (Join-Path $repo 'desktop/package.json') -Raw | ConvertFrom-Json).version
if ($version -cne '1.90.13') { throw 'This candidate is scoped to version 1.90.13.' }
$artifacts = Join-Path $repo 'desktop/artifacts/recovery-route-witness'
if (Test-Path -LiteralPath $artifacts) { throw 'Evidence already exists; do not overwrite it.' }
# Bound the retained fixture path before creating evidence or compiling. No OS
# long-path policy change is needed; a longer checkout must use a shorter path.
$fixtureTail = '.before-restore-attachments-' + ('x' * 36) + '\branding\logo-' + ('x' * 64) + '.png'
$longestFixture = Join-Path $artifacts ('t\' + ('x' * 32) + '\current\' + $fixtureTail)
if ($longestFixture.Length -ge 260) { throw 'Use a shorter disposable checkout path for the retained native fixtures; no OS policy change is authorized.' }
[IO.Directory]::CreateDirectory($artifacts) | Out-Null
$scratch = Join-Path $artifacts 't'
[IO.Directory]::CreateDirectory($scratch) | Out-Null
$names = @('TEMP','TMP','HELVICHANTIER_DATA_DIR','CARGO_NET_OFFLINE','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','ZENTRA_RECOVERY_CRASH_PROOF')
$saved = @{}
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$proof = [ordered]@{
  source=$ExpectedSource; version=$version; synthetic=$true; nativeExecution='compiled-library-harness';
  executed=$false; packageExecuted=$false; actualTauriIpcExecuted=$false; visualUiExecuted=$false;
  networkRequired=$false; liveHttpsExecuted=$false; physicalPowerLossVerified=$false;
  publishesInstaller=$false; publishesRelease=$false; installsApplication=$false;
  includeCrashCandidate=[bool]$IncludeCrashCandidate; startedAt=[DateTimeOffset]::UtcNow.ToString('o')
  sourceSnapshotSha256=$ExpectedSnapshotSha256; sourceIntegrityEvidence=$integrityArtifacts
}
try {
  $env:TEMP=$scratch
  $env:TMP=$scratch
  $env:HELVICHANTIER_DATA_DIR=Join-Path $scratch 'unused-app-profile'
  $env:CARGO_NET_OFFLINE='true'
  $env:HTTP_PROXY='http://127.0.0.1:9'
  $env:HTTPS_PROXY=$env:HTTP_PROXY
  $env:ALL_PROXY=$env:HTTP_PROXY
  $env:NO_PROXY='127.0.0.1,localhost'
  $env:ZENTRA_RECOVERY_CRASH_PROOF=Join-Path $artifacts 'crash'
  Set-Location -LiteralPath $repo
  . (Join-Path $repo 'desktop/scripts/windows-verification-harness.ps1')
  $harness = Initialize-ZentraVerificationHarness $repo $artifacts $ExpectedSource
  Invoke-ZentraVerificationSuite $harness 'backup::' @('--nocapture')
  Invoke-ZentraVerificationSuite $harness 'commands::worker_tests::manual_restore_refuses_in_flight_transfers_before_replacing_company_data' @('--exact')
  Invoke-ZentraVerificationSuite $harness 'license::tests::backup_recovery_restores_data_with_an_inactive_or_missing_license_without_granting_writes' @('--exact')
  Invoke-ZentraVerificationSuite $harness 'cloud_backup::tests::complete_backup_recovers_business_database_and_attachments_on_a_fresh_installation' @('--exact')
  Invoke-ZentraVerificationSuite $harness 'company_collaboration::account::tests'
  Invoke-ZentraVerificationSuite $harness 'company_collaboration::tests'
  Invoke-ZentraVerificationSuite $harness 'company_collaboration::member_context_private_tests'
  Invoke-ZentraVerificationSuite $harness 'company_collaboration::reference_worker_tests'
  Invoke-ZentraVerificationSuite $harness 'company_collaboration::content_version_compat_tests'
  Invoke-ZentraVerificationSuite $harness 'company_collaboration::merge_version_compat_tests'
  # Regression coverage only: this does not certify crash atomicity of the
  # intentional logout/post-reset cleanup outside the restore transaction.
  Invoke-ZentraVerificationSuite $harness 'app_reset::tests'
  Invoke-ZentraVerificationSuite $harness 'diagnostics::tests::restore_state_errors_keep_their_message_and_log_only_a_static_storage_category' @('--exact')
  Invoke-ZentraVerificationSuite $harness 'diagnostics::tests::native_errors_never_log_exception_text_or_paths' @('--exact')
  Invoke-ZentraVerificationSuite $harness 'diagnostics::async_error_tests::async_command_result_keeps_successes_and_original_failure_strings' @('--exact')
  # BEGIN ZENTRA STARTUP SELECTION
  $proof.startupSelectionContracts = & (Join-Path $repo 'desktop/scripts/native-startup-selection.contract-tests.ps1') -WrapperPath (Join-Path $repo 'desktop/scripts/verify-native-recovery.ps1') -HarnessPath (Join-Path $repo 'desktop/scripts/windows-verification-harness.ps1') -EvidenceDirectory (Join-Path $artifacts 'startup-selection-contracts')
  if ($proof.startupSelectionContracts.passed -ne $true -or $proof.startupSelectionContracts.nativeExecuted -ne $false -or $proof.startupSelectionContracts.powershellVersion -notmatch '^5\.1\.') { throw 'Startup selection contracts require the normal Windows PowerShell 5.1 CI runtime.' }
  $startupFilter = 'startup_recovery::tests::'
  $startupExpectedNames = @(
    'startup_recovery::tests::exact_origin_captures_every_variant_and_preserves_other_errors',
    'startup_recovery::tests::no_journal_happy_bool_and_refusal_priority_with_artificial_store',
    'startup_recovery::tests::invalid_journal_refuses_before_business_directories_identity_or_migration',
    'startup_recovery::tests::historical_hidden_profile_without_journal_never_creates_an_empty_company',
    'startup_recovery::tests::directory_and_post_recovery_database_failures_keep_historical_errors',
    'startup_recovery::tests::explicit_native_diagnostic_export_succeeds_or_refuses_without_business_store',
    'startup_recovery::tests::pending_blocked_preserves_active_previous_candidates_documents_and_logo',
    'startup_recovery::tests::real_recovery_database_and_validation_failures_are_tagged',
    'startup_recovery::tests::pending_valid_rolls_back_and_durable_phases_reopen_real_profiles',
    'startup_recovery::tests::durable_cleanup_io_refuses_boot_then_reopen_keeps_selected_profile'
  )
  $startupSelectedNames = @($harness.TestNames | Where-Object { $_.Contains($startupFilter) })
  $proof.startupRecovery = [ordered]@{
    filter=$startupFilter; expectedNames=$startupExpectedNames; selectedNames=$startupSelectedNames;
    verified=$false
  }
  if ($startupSelectedNames.Count -ne 10) { throw 'Startup recovery must select exactly ten Windows tests.' }
  foreach ($startupName in $startupExpectedNames) {
    if (@($startupSelectedNames | Where-Object { $_ -ceq $startupName }).Count -ne 1) {
      throw 'Startup recovery catalog differs from the reviewed ten exact names.'
    }
  }
  $startupSuiteIndex = $harness.Proof.suiteExecutions.Count
  Invoke-ZentraVerificationSuite $harness $startupFilter
  if ($harness.Proof.suiteExecutions.Count -ne ($startupSuiteIndex + 1)) {
    throw 'Startup recovery must produce one new verified harness execution.'
  }
  $startupResult = $harness.Proof.suiteExecutions[$startupSuiteIndex]
  if ($startupResult.filter -cne $startupFilter -or $startupResult.contextMode -cne 'diagnostics-verification' -or
      $startupResult.selectedNames -ne 10 -or $startupResult.exit -ne 0 -or
      $startupResult.passed -ne 10 -or $startupResult.failed -ne 0 -or $startupResult.ignored -ne 0 -or
      @($startupResult.extraArguments).Count -ne 0 -or
      @($startupResult.nativeArguments).Count -ne 2 -or
      $startupResult.nativeArguments[0] -cne $startupFilter -or
      $startupResult.nativeArguments[1] -cne '--test-threads=1') {
    throw 'Startup recovery requires ten passed, zero failed, zero ignored and the fixed libtest invocation.'
  }
  $startupStdout = Join-Path $harness.Artifacts $startupResult.stdout
  $startupOutput = [IO.File]::ReadAllText($startupStdout)
  $startupNamedResults = [regex]::Matches($startupOutput, '(?m)^test (?<name>[A-Za-z_][A-Za-z0-9_:]*) \.\.\. (?<result>ok|FAILED|ignored)(?:, [^\r\n]*)?\r?$')
  if ($startupNamedResults.Count -ne 10) { throw 'Startup recovery must report all ten named results.' }
  foreach ($startupName in $startupExpectedNames) {
    $startupNamed = @($startupNamedResults | Where-Object { $_.Groups['name'].Value -ceq $startupName })
    if ($startupNamed.Count -ne 1 -or $startupNamed[0].Groups['result'].Value -cne 'ok') {
      throw 'Startup recovery has a missing, duplicated or unsuccessful named result.'
    }
  }
  $startupSummaries = [regex]::Matches($startupOutput, '(?m)^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;[^\r\n]*\r?$')
  if ($startupSummaries.Count -ne 1 -or $startupSummaries[0].Groups[1].Value -cne 'ok' -or
      [int]$startupSummaries[0].Groups[2].Value -ne 10 -or
      [int]$startupSummaries[0].Groups[3].Value -ne 0 -or
      [int]$startupSummaries[0].Groups[4].Value -ne 0) {
    throw 'Startup recovery stdout requires one unambiguous ten/zero/zero success summary.'
  }
  $proof.startupRecovery.execution=$startupResult
  $proof.startupRecovery.namedResults=@($startupNamedResults | ForEach-Object {
    [ordered]@{name=$_.Groups['name'].Value;result=$_.Groups['result'].Value}
  })
  $proof.startupRecovery.stdoutSha256=(Get-FileHash -LiteralPath $startupStdout -Algorithm SHA256).Hash.ToLowerInvariant()
  $proof.startupRecovery.verified=$true
  # END ZENTRA STARTUP SELECTION
  if ($IncludeCrashCandidate) {
    # Explicit opt-in; this exact test must first be reviewed, merged and compiled.
    Invoke-ZentraVerificationSuite $harness 'backup::recovery_crash_tests::native_crash_boundaries_restore_one_complete_profile_before_migration' @('--exact','--ignored')
  }
  $proof.executed=$true
  $proof.suiteExecutions=$harness.Proof.suiteExecutions
  $proof.status='passed'
} catch {
  $proof.status='failed-or-blocked'
  $proof.error=[string]$_
  throw
} finally {
  try {
    Assert-ZentraRecoverySourceSnapshot $repo $ExpectedSource $SourceSnapshotPath $ExpectedSnapshotSha256 $integrityArtifacts 'after-recovery-harness'
  } catch {
    $proof.status='failed-or-blocked'
    $proof.error=[string]$_
    throw
  } finally {
    $proof.completedAt=[DateTimeOffset]::UtcNow.ToString('o')
    [IO.File]::WriteAllText((Join-Path $artifacts 'native-recovery-witness.json'), ($proof | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
  }
}
