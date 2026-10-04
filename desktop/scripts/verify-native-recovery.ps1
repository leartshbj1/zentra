[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Repository,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedSource,
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
$nativeChanges = @(& git -C $repo status --porcelain -- desktop/src-tauri desktop/scripts/windows-verification-harness.ps1)
if ($LASTEXITCODE -ne 0 -or $nativeChanges.Count -ne 0) { throw 'Native sources and reviewed harness must be committed and clean.' }
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
  $proof.completedAt=[DateTimeOffset]::UtcNow.ToString('o')
  [IO.File]::WriteAllText((Join-Path $artifacts 'native-recovery-witness.json'), ($proof | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}
