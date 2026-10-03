[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$diagnosticSelection = if ([string]::IsNullOrEmpty($env:ZENTRA_DIAGNOSTICS_NATIVE_SET)) {
    'full'
} else {
    $env:ZENTRA_DIAGNOSTICS_NATIVE_SET
}
if ($diagnosticSelection -cnotin @('full', 'native-mail-payroll', 'benchmark-payment', 'benchmark-public-payment')) {
    throw 'Unknown diagnostics native verification set.'
}
if ($diagnosticSelection -cne 'full' -and
    ($env:ZENTRA_VERIFY_DIAGNOSTICS_ONLY -cne 'true' -or $env:ZENTRA_VERIFY_ONLY -cne 'true')) {
    throw 'Targeted native verification requires both diagnostics and verification-only guards.'
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $repo
$artifacts = Join-Path $repo 'desktop/artifacts/windows'
[IO.Directory]::CreateDirectory($artifacts) | Out-Null
$toolsRoot = Join-Path $env:TEMP 'zentra-release-tools'
[IO.Directory]::CreateDirectory($toolsRoot) | Out-Null

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed ($LASTEXITCODE)" }
}

# Use vendor-hosted Node binaries, checked against the vendor's SHA-256 list.
$nodeBase = 'https://nodejs.org/dist/latest-v22.x'
$sums = (Invoke-WebRequest -UseBasicParsing "$nodeBase/SHASUMS256.txt").Content
$match = [regex]::Match($sums, '(?m)^([a-f0-9]{64})\s+(node-v22\.[0-9]+\.[0-9]+-win-x64\.zip)\s*$')
if (-not $match.Success) { throw 'Node 22 checksum not found' }
$zipName = $match.Groups[2].Value
$zipPath = Join-Path $toolsRoot $zipName
Invoke-WebRequest -UseBasicParsing "$nodeBase/$zipName" -OutFile $zipPath
if ((Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $match.Groups[1].Value) { throw 'Node checksum mismatch' }
Expand-Archive -LiteralPath $zipPath -DestinationPath $toolsRoot -Force
$nodeRoot = Join-Path $toolsRoot ([IO.Path]::GetFileNameWithoutExtension($zipName))
$env:PATH = "$nodeRoot;$env:APPDATA\npm;$env:USERPROFILE\.cargo\bin;$env:PATH"
Invoke-Checked npm.cmd @('install', '--global', 'pnpm@11.19.0', '--no-audit', '--no-fund')
if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) {
    $installer = Join-Path $toolsRoot 'rustup-init.exe'
    Invoke-WebRequest -UseBasicParsing 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' -OutFile $installer
    $checksumContent = (Invoke-WebRequest -UseBasicParsing 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe.sha256').Content
    $checksumText = if ($checksumContent -is [byte[]]) { [Text.Encoding]::UTF8.GetString($checksumContent) } else { [string]$checksumContent }
    $expected = ($checksumText.Trim() -split '\s+')[0]
    if ($expected -notmatch '^[a-f0-9]{64}$') { throw 'Invalid Rustup checksum document' }
    if ((Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Rustup checksum mismatch' }
    Invoke-Checked $installer @('-y', '--profile', 'minimal', '--default-toolchain', 'stable-x86_64-pc-windows-msvc')
}
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
$env:CARGO_PROFILE_TEST_DEBUG = '0'
Invoke-Checked rustup @('toolchain', 'install', $env:RUSTUP_TOOLCHAIN, '--profile', 'minimal')
Invoke-Checked pnpm.cmd @('install', '--frozen-lockfile')
Start-Transcript -Path (Join-Path $artifacts 'validation.log') | Out-Null
try {
    if ($env:ZENTRA_VERIFY_DIAGNOSTICS_ONLY -eq 'true') {
        if ($env:ZENTRA_VERIFY_ONLY -ne 'true') { throw 'Diagnostics validation requires the verification-only guard.' }
        $diagnosticSource = (& git rev-parse HEAD).Trim()
        if ($LASTEXITCODE -ne 0 -or $diagnosticSource -notmatch '^[0-9a-f]{40}$') { throw 'The checked-out diagnostics source is invalid.' }
        if ($env:CIRCLE_SHA1 -cne $diagnosticSource) { throw 'Diagnostics validation must use the exact CircleCI source revision.' }
        $diagnosticStartedAt = [DateTimeOffset]::UtcNow.ToString('o')
        & (Join-Path $PSScriptRoot 'diagnostics-native-selection.contract-tests.ps1')
        . (Join-Path $PSScriptRoot 'windows-verification-harness.ps1')
        & (Join-Path $PSScriptRoot 'windows-verification-harness.contract-tests.ps1') -NativeNodePath (Join-Path $nodeRoot 'node.exe')
        $diagnosticHarness = Initialize-ZentraVerificationHarness $repo $artifacts $diagnosticSource
        if ($diagnosticSelection -ceq 'native-mail-payroll') {
            $targetedFilters = @(
                [pscustomobject]@{ Name = 'outgoing_mail::integration_tests::settings_signature_preservation_tests::'; Arguments = @() },
                [pscustomobject]@{ Name = 'commands::payroll_import_worker_tests::'; Arguments = @() },
                [pscustomobject]@{ Name = 'payroll_import::tests::'; Arguments = @() },
                [pscustomobject]@{ Name = 'outgoing_mail::integration_tests::mail_templates_roundtrip_and_credentials_stay_out_of_business_data'; Arguments = @('--exact') },
                [pscustomobject]@{ Name = 'outgoing_mail::integration_tests::mail_logo_'; Arguments = @() }
            )
            foreach ($filter in $targetedFilters) {
                Invoke-ZentraVerificationSuite $diagnosticHarness $filter.Name $filter.Arguments
            }
            $targetedProof = [ordered]@{
                source = $diagnosticSource; circleSource = $env:CIRCLE_SHA1
                selection = $diagnosticSelection; verificationOnly = $true
                target = 'x86_64-pc-windows-msvc'; nativeProfile = 'release'
                data = 'synthetic'; nativeExecution = 'compiled-library-harness'
                nativeFilters = @($targetedFilters | ForEach-Object { $_.Name })
                suiteExecutions = $diagnosticHarness.Proof.suiteExecutions
                nativeHarnessProof = 'windows-test-harness-proof.json'
                testOnlyManifestTransformation = $diagnosticHarness.Proof.testOnlyManifestTransformation
                loaderHypothesisConfirmed = $diagnosticHarness.Proof.loaderHypothesisConfirmed
                harnessManifestRepairValidated = $diagnosticHarness.Proof.harnessManifestRepairValidated
                selectedNativeSuitesPassed = $true
                frontendExecuted = $false; mobileExecuted = $false
                frontendBuildExecuted = $false; benchmarksExecuted = $false
                publishesInstaller = $false; publishesRelease = $false; installsApplication = $false
                startedAt = $diagnosticStartedAt; completedAt = [DateTimeOffset]::UtcNow.ToString('o')
            }
            [IO.File]::WriteAllText((Join-Path $artifacts 'diagnostics-native-targeted-proof.json'), ($targetedProof | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
            return
        }
        if ($diagnosticSelection -ceq 'benchmark-payment') {
            $env:ZENTRA_PAYMENT_BENCHMARK_JSON = Join-Path $artifacts 'payment-workspace-benchmark.json'
            $paymentBenchmark = 'database::workspace_payment_projection_tests::benchmark_real_payment_workspace_densities'
            Invoke-ZentraVerificationSuite $diagnosticHarness $paymentBenchmark @('--ignored','--exact','--nocapture')
            if (-not (Test-Path -LiteralPath $env:ZENTRA_PAYMENT_BENCHMARK_JSON -PathType Leaf)) { throw 'Payment benchmark proof was not created.' }
            $paymentBenchmarkProof = Get-Content -LiteralPath $env:ZENTRA_PAYMENT_BENCHMARK_JSON -Raw | ConvertFrom-Json
            if ($paymentBenchmarkProof.synthetic -ne $true -or $paymentBenchmarkProof.optimized -ne $true -or $paymentBenchmarkProof.densities.Count -ne 3) { throw 'Payment benchmark proof does not cover the synthetic optimized fixtures.' }
            foreach ($density in $paymentBenchmarkProof.densities) {
                if ($density.allRetainedValuesEqual -ne $true -or $density.payments -ne 1024 -or $density.runs.Count -ne 12) { throw 'Payment benchmark parity or required density is incomplete.' }
            }
            $benchmarkOnlyProof = [ordered]@{
                source = $diagnosticSource; circleSource = $env:CIRCLE_SHA1
                selection = $diagnosticSelection; verificationOnly = $true
                target = 'x86_64-pc-windows-msvc'; nativeProfile = 'release'
                data = 'synthetic'; nativeExecution = 'compiled-library-harness'
                nativeFilters = @($paymentBenchmark); suiteExecutions = $diagnosticHarness.Proof.suiteExecutions
                nativeHarnessProof = 'windows-test-harness-proof.json'
                benchmarkProof = 'payment-workspace-benchmark.json'; selectedBenchmarkPassed = $true
                testOnlyManifestTransformation = $diagnosticHarness.Proof.testOnlyManifestTransformation
                loaderHypothesisConfirmed = $diagnosticHarness.Proof.loaderHypothesisConfirmed
                harnessManifestRepairValidated = $diagnosticHarness.Proof.harnessManifestRepairValidated
                fullFunctionalExecuted = $false; frontendExecuted = $false; mobileExecuted = $false
                frontendBuildExecuted = $false; benchmarksExecuted = $true
                publishesInstaller = $false; publishesRelease = $false; installsApplication = $false
                startedAt = $diagnosticStartedAt; completedAt = [DateTimeOffset]::UtcNow.ToString('o')
            }
            [IO.File]::WriteAllText((Join-Path $artifacts 'diagnostics-benchmark-payment-proof.json'), ($benchmarkOnlyProof | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
            return
        }
        if ($diagnosticSelection -ceq 'benchmark-public-payment') {
            $env:ZENTRA_PUBLIC_PAYMENT_BENCHMARK_JSON = Join-Path $artifacts 'public-payment-workspace-benchmark.json'
            $publicPaymentBenchmark = 'database::workspace_payment_projection_tests::payment_read_projection_tests::benchmark_public_payment_workspace_densities'
            Invoke-ZentraVerificationSuite $diagnosticHarness $publicPaymentBenchmark @('--ignored','--exact','--nocapture')
            if (-not (Test-Path -LiteralPath $env:ZENTRA_PUBLIC_PAYMENT_BENCHMARK_JSON -PathType Leaf)) { throw 'Public-getter benchmark proof was not created.' }
            $publicPaymentProof = Get-Content -LiteralPath $env:ZENTRA_PUBLIC_PAYMENT_BENCHMARK_JSON -Raw | ConvertFrom-Json
            if ($publicPaymentProof.synthetic -ne $true -or $publicPaymentProof.optimized -ne $true -or $publicPaymentProof.densities.Count -ne 3) { throw 'Public-getter benchmark fixtures are incomplete.' }
            foreach ($density in $publicPaymentProof.densities) {
                if ($density.allRetainedValuesEqual -ne $true -or $density.publicGetters -ne $true -or $density.payments -ne 1024 -or $density.runs.Count -ne 6 -or $density.individualPaymentProofsChecked -ne $true) { throw 'Public-getter benchmark parity or required density is incomplete.' }
            }
            $benchmarkOnlyProof = [ordered]@{
                source = $diagnosticSource; circleSource = $env:CIRCLE_SHA1
                selection = $diagnosticSelection; verificationOnly = $true
                target = 'x86_64-pc-windows-msvc'; nativeProfile = 'release'
                data = 'synthetic'; nativeExecution = 'compiled-library-harness'
                nativeFilters = @($publicPaymentBenchmark); suiteExecutions = $diagnosticHarness.Proof.suiteExecutions
                nativeHarnessProof = 'windows-test-harness-proof.json'
                benchmarkProof = 'public-payment-workspace-benchmark.json'; selectedBenchmarkPassed = $true
                testOnlyManifestTransformation = $diagnosticHarness.Proof.testOnlyManifestTransformation
                loaderHypothesisConfirmed = $diagnosticHarness.Proof.loaderHypothesisConfirmed
                harnessManifestRepairValidated = $diagnosticHarness.Proof.harnessManifestRepairValidated
                fullFunctionalExecuted = $false; frontendExecuted = $false; mobileExecuted = $false
                frontendBuildExecuted = $false; benchmarksExecuted = $true
                publishesInstaller = $false; publishesRelease = $false; installsApplication = $false
                startedAt = $diagnosticStartedAt; completedAt = [DateTimeOffset]::UtcNow.ToString('o')
            }
            [IO.File]::WriteAllText((Join-Path $artifacts 'diagnostics-benchmark-public-payment-proof.json'), ($benchmarkOnlyProof | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
            return
        }
        $diagnosticNativeSuites = @('diagnostics', 'startup_updater_config_tests', 'account_cloud::tests', 'account_cloud::inbox_read_tests', 'account_cloud::archive_worker_tests', 'company_collaboration::tests', 'company_collaboration::account::tests', 'commands::worker_tests', 'commands::pdf_worker_tests', 'commands::import_worker_tests', 'commands::project_file_scope_tests', 'license::tests', 'supplier_inbox::tests', 'appointment_inbox::tests', 'document_design::tests', 'financial_pdf::layout_tests', 'sales_pdf::tests', 'payroll_pdf::tests', 'salary_certificate::tests', 'project_report::tests', 'tests::annual_accounts_pdf_reads_the_ledger_and_keeps_the_existing_file_on_currency_error', 'tests::document_design_settings_are_validated_and_issued_sales_keep_their_original_pdf', 'backup::', 'tests::backup_restore_round_trip_recovers_local_rows', 'project_sync::tests', 'database::workspace_payment_projection_tests', 'accounting::historical_payment_guard_tests', 'customer_credit_tests::', 'tests::received_vat_is_deferred_then_reclassified_on_each_payment_and_credit_note')
        $diagnosticFrontendSuites = @('src/diagnostics.test.ts', 'src/formDrafts.test.ts', 'src/userErrors.test.ts', 'src/ErrorGuidance.test.tsx', 'src/DiagnosticsPanel.test.tsx', 'src/DiagnosticBoundary.test.tsx', 'src/payrollAssistantDiagnostics.test.ts', 'src/payrollLocalAi.test.ts', 'src/companyReceiveRefresh.test.ts', 'src/projectSyncScheduler.test.ts', 'src/companySyncDiagnostics.test.ts', 'src/companyRealtime.test.ts', 'src/nativePluginDiagnostics.test.ts', 'src/mobileFileDiagnostics.test.ts', 'src/projectDocumentRead.test.ts', 'src/projectFileSessions.test.ts', 'src/projectFileScope.test.ts', 'src/refundAttachments.test.tsx', 'src/documentExportBridge.test.ts', 'src/salesPdfExport.test.ts', 'src/bank.test.ts', 'src/bankRefunds.test.tsx', 'src/bankRefundCreate.test.tsx', 'src/bankCustomerRefundBridge.test.ts', 'src/nativeNavigationSession.test.ts', 'src/nativeNavigationContract.test.ts', 'src/importScopeBridge.test.ts', 'src/workspaceReception.test.ts', 'src/supplierInboxQueue.test.ts', 'src/supplierInboxReview.test.ts', 'src/supplierInboxBatch.test.ts', 'src/inboxManualImport.test.tsx', 'src/SupplierHabits.test.tsx', 'src/invoiceArchiveScope.test.ts', 'src/projectSyncDiagnostics.test.tsx', 'src/DeferredViewDiagnostics.test.tsx', 'src/AutomationDocumentDiagnostics.test.tsx')
        $diagnosticMobileSuites = @('src/diagnostics.test.ts', 'src/nativePluginDiagnostics.test.ts', 'src/mobileFileDiagnostics.test.ts', 'src/nativeNavigationSession.test.ts', 'src/nativeNavigationContract.test.ts', 'src/projectSyncDiagnostics.test.tsx', 'src/DeferredViewDiagnostics.test.tsx', 'src/AutomationDocumentDiagnostics.test.tsx')
        $diagnosticNativeSuites += @('outgoing_mail::')
        $diagnosticFrontendSuites += @('src/payrollPdfText.test.ts', 'src/localPdfPreview.test.ts', 'src/DocumentPreviewFrame.test.tsx')
        $diagnosticMobileSuites += @('src/payrollPdfText.test.ts', 'src/localPdfPreview.test.ts', 'src/DocumentPreviewFrame.test.tsx')
        $diagnosticFrontendSuites += @('src/workNotes.test.ts', 'src/workNotesBridge.test.ts', 'src/FixedAssetsPanel.test.tsx')
        $diagnosticMobileSuites += @('src/workNotes.test.ts', 'src/workNotesBridge.test.ts', 'src/FixedAssetsPanel.test.tsx')
        $diagnosticFrontendSuites += @('src/attachmentScope.test.tsx', 'src/AppointmentInboxLifecycle.test.tsx', 'src/agenda.test.ts', 'src/agendaForm.test.ts', 'src/agendaBridge.test.ts')
        $diagnosticMobileSuites += @('src/attachmentScope.test.tsx', 'src/AppointmentInboxLifecycle.test.tsx', 'src/agenda.test.ts', 'src/agendaForm.test.ts', 'src/agendaBridge.test.ts')
        $diagnosticFrontendSuites += @('src/ErrorDetailsCopy.test.tsx', 'src/FixedAssetsAccountPreparation.test.tsx')
        $diagnosticMobileSuites += @('src/ErrorDetailsCopy.test.tsx', 'src/FixedAssetsAccountPreparation.test.tsx')
        $diagnosticNativeSuites += @('work_notes::')
        $diagnosticFrontendSuites += @('src/NotesScreenLifecycle.test.tsx', 'src/PayrollSetupLifecycle.test.tsx')
        $diagnosticMobileSuites += @('src/NotesScreenLifecycle.test.tsx', 'src/PayrollSetupLifecycle.test.tsx')
        $diagnosticFrontendSuites += @('src/backgroundScanBridge.test.ts', 'src/FinanceConfigurationLifecycle.test.tsx')
        $diagnosticMobileSuites += @('src/backgroundScanBridge.test.ts', 'src/FinanceConfigurationLifecycle.test.tsx')
        $diagnosticFrontendSuites += @('src/BusinessProfileGateLifecycle.test.tsx', 'src/diagnosticIntent.test.ts', 'src/languageDiagnostics.test.ts', 'src/languageLoading.test.ts')
        $diagnosticMobileSuites += @('src/BusinessProfileGateLifecycle.test.tsx', 'src/diagnosticIntent.test.ts', 'src/languageDiagnostics.test.ts', 'src/languageLoading.test.ts')
        $diagnosticFrontendSuites += @('src/localModelInstallationDiagnostics.test.ts')
        $diagnosticMobileSuites += @('src/localModelInstallationDiagnostics.test.ts', 'src/payrollLocalAi.test.ts')
        $diagnosticNativeSuites += @('app_reset::tests')
        $diagnosticFrontendSuites += @('src/EmployeeDocumentImportAdmission.test.tsx', 'src/InvoiceScanPanelLifecycle.test.tsx', 'src/PayrollImportWizardAdmission.test.tsx', 'src/ResetActionsLifecycle.test.tsx', 'src/resetApp.test.ts')
        $diagnosticMobileSuites += @('src/EmployeeDocumentImportAdmission.test.tsx', 'src/InvoiceScanPanelLifecycle.test.tsx', 'src/PayrollImportWizardAdmission.test.tsx', 'src/ResetActionsLifecycle.test.tsx', 'src/resetApp.test.ts')
        $diagnosticFrontendSuites += @('src/payrollAnalysisDiagnostics.test.ts')
        $diagnosticMobileSuites += @('src/payrollAnalysisDiagnostics.test.ts')
        $diagnosticNativeSuites += @('commands::payroll_import_worker_tests::', 'payroll_import::tests::')
        $diagnosticFrontendSuites += @('src/payrollImportScopeBridge.test.ts', 'src/PayrollImportWizardLifecycle.test.tsx')
        $diagnosticMobileSuites += @('src/payrollImportScopeBridge.test.ts', 'src/PayrollImportWizardLifecycle.test.tsx')
        $diagnosticNativeSuites += @('commands::stock_report_scope_tests::', 'stock::tests::')
        $diagnosticFrontendSuites += @('src/stockMutation.test.ts', 'src/stockWorkflow.test.ts', 'src/stockScopedWorkflow.test.ts')
        $diagnosticMobileSuites += @('src/stockMutation.test.ts', 'src/stockWorkflow.test.ts', 'src/stockScopedWorkflow.test.ts')
        $diagnosticFrontendSuites += @('src/businessStatusNumbers.test.ts')
        $diagnosticMobileSuites += @('src/businessStatusNumbers.test.ts')
        $diagnosticNativeSuites += @('commands::closure_worker_tests::', 'commands::annual_export_scope_tests::')
        $diagnosticFrontendSuites += @('src/closingScopeBridge.test.ts', 'src/closingExportBridge.test.ts', 'src/bexioContactRouting.test.ts', 'src/catalogImport.test.ts', 'src/bexioImport.test.ts')
        $diagnosticMobileSuites += @('src/closingScopeBridge.test.ts', 'src/closingExportBridge.test.ts', 'src/bexioContactRouting.test.ts', 'src/catalogImport.test.ts', 'src/bexioImport.test.ts')
        $diagnosticNativeSuites += @('bank_import::tests::expense_tests::supplier_credit_refund_tests::', 'time_billing::tests::', 'tests::time_billing_', 'database::timer_work_date_tests::', 'commands::time_billing_scope_tests::', 'tests::time_invoice_customization_tests::')
        $diagnosticFrontendSuites += @('src/bankSupplierRefundHistory.test.tsx', 'src/timeBillingPrecision.test.ts', 'src/monetaryRounding.test.ts', 'src/monetaryLegacyCompatibility.test.ts', 'src/projectReportTimeQuantity.test.ts', 'src/timeBilling.test.ts', 'src/timeEntryForm.test.ts')
        $diagnosticMobileSuites += @('src/bankSupplierRefundHistory.test.tsx', 'src/timeBillingPrecision.test.ts', 'src/monetaryRounding.test.ts', 'src/monetaryLegacyCompatibility.test.ts', 'src/projectReportTimeQuantity.test.ts', 'src/timeBilling.test.ts', 'src/timeEntryForm.test.ts')
        $diagnosticNativeSuites += @('fixed_assets::tests::', 'commands::payment_forms_scope_tests::')
        $diagnosticFrontendSuites += @('src/customerCreditRequestScope.test.ts', 'src/paymentFormsScopeBridge.test.ts')
        $diagnosticMobileSuites += @('src/customerCreditRequestScope.test.ts', 'src/paymentFormsScopeBridge.test.ts')
        $diagnosticNativeSuites += @('commands::attachment_mutation_scope_tests::', 'commands::bank_file_scope_tests::')
        $diagnosticFrontendSuites += @('src/attachmentMutationScope.test.ts', 'src/bankFileMutationBridge.test.ts')
        $diagnosticMobileSuites += @('src/attachmentMutationScope.test.ts', 'src/bankFileMutationBridge.test.ts')
        $diagnosticNativeSuites += @('commands::bank_pending_scope_tests::')
        $diagnosticFrontendSuites += @('src/customerCreditRecoveryScope.test.ts', 'src/customerCreditRecoveryScopeBridge.test.ts', 'src/customerCreditRecoveryState.test.tsx', 'src/bankPendingScope.test.ts')
        $diagnosticMobileSuites += @('src/customerCreditRecoveryScope.test.ts', 'src/customerCreditRecoveryScopeBridge.test.ts', 'src/customerCreditRecoveryState.test.tsx', 'src/bankPendingScope.test.ts')
        $diagnosticFrontendSuites += @('src/bankCustomerRefundCleanupDiagnostics.test.ts', 'src/PdfAttachmentPreviewDiagnostics.test.tsx')
        $diagnosticMobileSuites += @('src/bankCustomerRefundCleanupDiagnostics.test.ts', 'src/PdfAttachmentPreviewDiagnostics.test.tsx')
        $diagnosticNativeSuites += @('commands::payment_request_recovery_tests::')
        $diagnosticFrontendSuites += @('src/paymentRequest.test.ts', 'src/paymentRequestBridge.test.ts', 'src/WorkTimeDraftRecovery.test.tsx')
        $diagnosticMobileSuites += @('src/paymentRequest.test.ts', 'src/paymentRequestBridge.test.ts', 'src/WorkTimeDraftRecovery.test.tsx')
        foreach ($suite in $diagnosticNativeSuites) {
            Invoke-ZentraVerificationSuite $diagnosticHarness $suite
        }
        $diagnosticPreviousPlatform = $env:TAURI_ENV_PLATFORM
        try {
            $env:TAURI_ENV_PLATFORM = 'desktop'
            Invoke-Checked pnpm.cmd (@('--dir', 'desktop', 'exec', 'vitest', 'run', '--maxWorkers=2') + $diagnosticFrontendSuites)
            foreach ($platform in @('ios', 'android')) {
                $env:TAURI_ENV_PLATFORM = $platform
                Invoke-Checked pnpm.cmd (@('--dir', 'desktop', 'exec', 'vitest', 'run', '--maxWorkers=2') + $diagnosticMobileSuites)
            }
        } finally {
            if ($null -eq $diagnosticPreviousPlatform) {
                Remove-Item Env:TAURI_ENV_PLATFORM -ErrorAction SilentlyContinue
            } else {
                $env:TAURI_ENV_PLATFORM = $diagnosticPreviousPlatform
            }
        }
        Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'build:web')
        $diagnosticProof = [ordered]@{
            source = $diagnosticSource; circleSource = $env:CIRCLE_SHA1; target = 'x86_64-pc-windows-msvc'
            version = (Get-Content desktop/package.json -Raw | ConvertFrom-Json).version
            data = 'synthetic'; nativeSuites = $diagnosticNativeSuites; frontendSuites = $diagnosticFrontendSuites
            frontendPlatforms = @('desktop', 'ios', 'android'); mobileSuites = $diagnosticMobileSuites
            allCheckedSuitesPassed = $true; frontendBuildPassed = $true; nativeProfile = 'release'
            nativeExecution = 'compiled-library-harness'; nativeHarnessProof = 'windows-test-harness-proof.json'
            testOnlyManifestTransformation = $diagnosticHarness.Proof.testOnlyManifestTransformation
            loaderHypothesisConfirmed = $diagnosticHarness.Proof.loaderHypothesisConfirmed
            harnessManifestRepairValidated = $diagnosticHarness.Proof.harnessManifestRepairValidated
            specificMissingDllOrSymbolConfirmed = $false
            selection = $diagnosticSelection; functionalValidationPassed = $true; benchmarksExecuted = $false
            requiredBenchmarkSelections = @('benchmark-payment', 'benchmark-public-payment')
            startedAt = $diagnosticStartedAt; completedAt = [DateTimeOffset]::UtcNow.ToString('o')
            publishesInstaller = $false; publishesRelease = $false; installsApplication = $false
        }
        [IO.File]::WriteAllText((Join-Path $artifacts 'diagnostics-validation-proof.json'), ($diagnosticProof | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
        return
    }
    if ($env:ZENTRA_VERIFY_PDF_ONLY -eq 'true') {
        $env:ZENTRA_DESIGN_SAMPLES = Join-Path $artifacts 'pdf-samples'
        [IO.Directory]::CreateDirectory($env:ZENTRA_DESIGN_SAMPLES) | Out-Null
        foreach ($suite in @('document_composition::', 'financial_pdf::', 'sales_pdf::tests', 'payroll_pdf::tests', 'project_report::tests')) {
            Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', $suite, '--', '--test-threads=1')
        }
        $proof = [ordered]@{source = (& git rev-parse HEAD).Trim(); data = 'synthetic'; suites = @('document_composition','financial_pdf','sales_pdf','payroll_pdf','project_report'); completedAt = [DateTimeOffset]::UtcNow.ToString('o'); publishesInstaller = $false}
        [IO.File]::WriteAllText((Join-Path $artifacts 'pdf-pagination-proof.json'), ($proof | ConvertTo-Json -Depth 3), [Text.UTF8Encoding]::new($false))
        return
    }
    if ($env:ZENTRA_VERIFY_UPDATER_ONLY -eq 'true') {
        Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'app_updater::tests', '--', '--test-threads=1')
        Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'exec', 'vitest', 'run', 'src/updaterReleaseContract.test.ts', 'src/updateAvailability.test.ts', 'src/appUpdaterLogic.test.ts')
        $updaterProof = [ordered]@{source = (& git rev-parse HEAD).Trim(); data = 'synthetic'; completedAt = [DateTimeOffset]::UtcNow.ToString('o'); publishesInstaller = $false}
        [IO.File]::WriteAllText((Join-Path $artifacts 'updater-channel-proof.json'), ($updaterProof | ConvertTo-Json -Depth 3), [Text.UTF8Encoding]::new($false))
        return
    }
    if ($env:ZENTRA_VERIFY_BACKUP_ONLY -eq 'true') {
        foreach ($suite in @('backup::', 'branding::tests', 'project_documents::tests', 'cloud_backup::tests', 'company_collaboration::tests')) {
            Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', $suite, '--', '--test-threads=1')
        }
        $backupProof = [ordered]@{source = (& git rev-parse HEAD).Trim(); data = 'synthetic'; suites = @('backup', 'branding', 'project_documents', 'cloud_backup', 'company_collaboration'); completedAt = [DateTimeOffset]::UtcNow.ToString('o'); publishesInstaller = $false}
        [IO.File]::WriteAllText((Join-Path $artifacts 'backup-recovery-proof.json'), ($backupProof | ConvertTo-Json -Depth 3), [Text.UTF8Encoding]::new($false))
        return
    }
    if ($env:ZENTRA_VERIFY_REPORTS_ONLY -eq 'true') {
        Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'exec', 'vitest', 'run', 'src/projectReport.test.ts', 'src/salesPdfExport.test.ts', 'src/projectPlanning.test.ts')
        Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'build:web')
        Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'project_report::tests', '--', '--test-threads=1')
        foreach ($sample in @('summary', 'client', 'internal', 'long')) {
            $env:ZENTRA_PROJECT_REPORT_JSON = Join-Path $repo "desktop/tests/fixtures/project-reports/$sample.json"
            $env:ZENTRA_PROJECT_REPORT_SAMPLE = Join-Path $artifacts "$sample.pdf"
            Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'project_report::tests::render_frontend_report_fixture', '--', '--ignored', '--exact')
        }
        $reportProof = [ordered]@{source = (& git rev-parse HEAD).Trim(); renderer = 'project_report::render'; data = 'synthetic'; samples = @('summary', 'client', 'internal', 'long'); completedAt = [DateTimeOffset]::UtcNow.ToString('o')}
        [IO.File]::WriteAllText((Join-Path $artifacts 'project-report-proof.json'), ($reportProof | ConvertTo-Json -Depth 3), [Text.UTF8Encoding]::new($false))
        return
    }
    Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'exec', 'vitest', 'run', 'src/bexioImport.test.ts', 'src/catalogImport.test.ts')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'bexio_import', '--', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'catalog_import', '--', '--test-threads=1')
    Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'exec', 'vitest', 'run', 'src/outgoingMail.test.ts', 'src/remindersUi.test.ts', 'src/reminderBridge.test.ts')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'outgoing_mail', '--', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'fixed_assets', '--', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'input_vat', '--', '--test-threads=1')
    Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'exec', 'vitest', 'run', 'src/invoiceScan.test.ts', 'src/supplierInvoicePreparation.test.ts')
    Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'exec', 'vitest', 'run', 'src/runtimeFinancials.test.ts', 'src/workspaceIndexBridge.test.ts', 'src/runtimePerformance.test.ts', 'src/rowIndex.test.ts', 'src/workspaceFinancialRelations.test.ts', 'src/dashboardDeadlines.test.ts')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'interface_workspace_', '--', '--test-threads=1')
    Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'exec', 'vitest', 'run', 'src/workspacePreferences.test.ts', 'src/workspacePersonalizationLanguage.test.ts', 'src/nativeNavigationSession.test.ts', 'src/companySyncPresentation.test.ts')
    Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'exec', 'vitest', 'run', 'src/companyAccount.test.ts', 'src/companyRealtime.test.ts', 'src/projectSyncScheduler.test.ts', 'src/automationCompanySession.test.ts', 'src/appReleaseNotes.test.ts', 'src/automationDailySummary.test.tsx', 'src/automationHub.test.tsx', 'src/automationJournal.test.tsx', 'src/automationNavigation.test.tsx', 'src/appearance.test.ts', 'src/supplierInboxReview.test.ts', 'src/supplierInboxBatch.test.ts', 'src/languageCatalogCoverage.test.ts', 'src/projectReport.test.ts')
    Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'exec', 'vitest', 'run', 'src/workNotes.test.ts', 'src/workNotesBridge.test.ts')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'work_notes', '--', '--test-threads=1')
    Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'build:web')
    Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'exec', 'vitest', 'run', 'src/quoteInterlocutor.test.ts')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'quote_interlocutor', '--', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'sales_pdf::tests', '--', '--test-threads=1')
    Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'exec', 'vitest', 'run', 'src/documentDesignLanguage.test.ts', 'src/documentDesignTools.test.ts', 'src/documentDesignValidation.test.ts', 'src/documentTemplates.test.ts', 'src/richTextEditing.test.ts', 'src/richTextSearch.test.ts')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'document_composition::', '--', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'company_', '--', '--nocapture', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'account_cloud::tests', '--', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'backup::tests', '--', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'app_updater::tests', '--', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'branding::tests', '--', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'project_documents::tests', '--', '--test-threads=1')
    Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'exec', 'vitest', 'run', 'src/updaterReleaseContract.test.ts', 'src/updateAvailability.test.ts', 'src/appUpdaterLogic.test.ts')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'supplier_inbox::tests', '--', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'appointment_inbox::tests', '--', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'project_report::tests', '--', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'automation::tests', '--', '--test-threads=1')
    if ($env:ZENTRA_VERIFY_ONLY -eq 'true') { return }
    $config = Get-Content desktop/src-tauri/tauri.updater.conf.json -Raw | ConvertFrom-Json
    $config.bundle.createUpdaterArtifacts = $false
    $env:ELYKO_UPDATER_PUBLIC_KEY = (Get-Content desktop/src-tauri/updater-public-key.txt -Raw).Trim()
    $env:ELYKO_UPDATER_ENDPOINT = 'https://zentraapp.ch/updates/latest-windows.json'
    $config.plugins.updater.pubkey = $env:ELYKO_UPDATER_PUBLIC_KEY
    $generated = Join-Path $repo 'desktop/src-tauri/tauri.updater.generated-cloud.conf.json'
    [IO.File]::WriteAllText($generated, ($config | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'exec', 'tauri', 'build', '--target', 'x86_64-pc-windows-msvc', '--bundles', 'nsis', '--config', $generated)
    $version = (Get-Content desktop/package.json -Raw | ConvertFrom-Json).version
    $releaseRoot = Join-Path $repo 'desktop/src-tauri/target/x86_64-pc-windows-msvc/release'
    $exe = Join-Path $releaseRoot 'Zentra.exe'
    $setup = Join-Path $releaseRoot "bundle/nsis/Zentra_${version}_x64-setup.exe"
    foreach ($file in @($exe, $setup)) {
        if (-not (Test-Path $file -PathType Leaf) -or (Get-Item $file).Length -lt 1000000) { throw "Missing build artifact: $file" }
        Copy-Item -LiteralPath $file -Destination $artifacts
    }
    $source = (& git rev-parse HEAD).Trim()
    $proof = [ordered]@{
        version = $version; source = $source; target = 'x86_64-pc-windows-msvc'
        identifier = 'ch.helvichantier.desktop'; builtAt = [DateTimeOffset]::UtcNow.ToString('o')
        updaterEndpoint = $env:ELYKO_UPDATER_ENDPOINT; updaterPublicKey = $env:ELYKO_UPDATER_PUBLIC_KEY
        companyTestsPassed = $true; accountTestsPassed = $true; authenticodeSigned = $false
        documentCompositionTestsPassed = $true; documentEditorTestsPassed = $true
        bexioImportTestsPassed = $true; catalogImportTestsPassed = $true
        outgoingMailTestsPassed = $true; fixedAssetsTestsPassed = $true; inputVatTestsPassed = $true; invoiceScanTestsPassed = $true
        interfaceWorkspaceTestsPassed = $true
        files = @($exe, $setup | ForEach-Object { [ordered]@{name = (Split-Path $_ -Leaf); size = (Get-Item $_).Length; sha256 = (Get-FileHash $_ -Algorithm SHA256).Hash.ToLowerInvariant()} })
    }
    [IO.File]::WriteAllText((Join-Path $artifacts 'provenance.json'), ($proof | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
} finally {
    Stop-Transcript | Out-Null
}
