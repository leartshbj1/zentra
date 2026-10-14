# Separate one-node opt-in CI recipe. Local checks must parse this file and
# extract its pure functions; never invoke or dot-source this CI entrypoint locally.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-ZentraLiveProfileAdmission {
    param([Parameter(Mandatory=$true)][Collections.IDictionary]$Context)
    $required = [ordered]@{
        CIRCLECI='true'; OS='Windows_NT'; CIRCLE_BRANCH='codex/action-engine-native-live-a41'
        CIRCLE_NODE_INDEX='0'; CIRCLE_NODE_TOTAL='1'
        ZENTRA_VERIFY_DIAGNOSTICS_ONLY='true'; ZENTRA_VERIFY_ONLY='true'
        ZENTRA_VERIFY_NATIVE_PROFILE_ONLY='false'; ZENTRA_VERIFY_LIVE_PROFILE_ONLY='true'
        ZENTRA_LIVE_PROFILE_RELEASE='false'; ZENTRA_DIAGNOSTICS_NATIVE_SET='action-engine'
        RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
    }
    foreach ($name in $required.Keys) {
        if (-not $Context.Contains($name) -or $Context[$name] -isnot [string] -or $Context[$name] -cne $required[$name]) {
            throw 'Live profile verification requires the exact one-node Windows CI admission.'
        }
    }
    foreach ($name in @('ZENTRA_LIVE_PROFILE_PIPELINE_ID','CIRCLE_WORKFLOW_ID')) {
        if (-not $Context.Contains($name) -or $Context[$name] -isnot [string] -or $Context[$name] -cnotmatch '\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z') {
            throw 'Live profile verification requires exact pipeline and workflow identities.'
        }
    }
    if (-not $Context.Contains('CIRCLE_SHA1') -or $Context['CIRCLE_SHA1'] -isnot [string] -or $Context['CIRCLE_SHA1'] -cnotmatch '\A[0-9a-f]{40}\z' -or
        -not $Context.Contains('CIRCLE_BUILD_NUM') -or $Context['CIRCLE_BUILD_NUM'] -isnot [string] -or $Context['CIRCLE_BUILD_NUM'] -cnotmatch '\A[1-9][0-9]{0,9}\z') {
        throw 'Live profile verification requires an exact source and job number.'
    }
    foreach ($name in @('CARGO_TARGET_DIR','ZENTRA_ACTION_NATIVE_TEST_CONTEXT','ZENTRA_ACTION_NATIVE_TEST_PROFILE_JSON','ZENTRA_ACTION_NATIVE_TEST_PROFILE_SHA256','ZENTRA_ACTION_FULL_ARCHIVE_EVIDENCE')) {
        if ($Context.Contains($name) -and -not [string]::IsNullOrEmpty($Context[$name])) {
            throw 'Live profile verification refuses inherited compile or archive inputs.'
        }
    }
}

function Get-ZentraLiveProfilePlan {
    param([Parameter(Mandatory=$true)][AllowEmptyCollection()][string[]]$TestNames)
    $catalogue = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $TestNames) {
        if ($name -cnotmatch '\A[A-Za-z_][A-Za-z0-9_:]*\z' -or -not $catalogue.Add($name)) { throw 'Invalid or duplicate live-profile catalogue test.' }
    }
    $selected = [string[]]@(
        'native_test_profile::live_a41_context_tests::live_a41_compilation_context_admits_only_exact_public_tuple'
        'native_test_profile::tests::absent_compilation_inputs_are_unconfigured_and_partial_inputs_refuse'
        'native_test_profile::tests::sites_access_header_is_sensitive_and_preserves_device_authorization_and_body'
        'native_test_profile::tests::sites_access_rejects_invalid_tokens_without_retaining_them'
        'native_test_profile::tests::sites_access_installation_requires_a_valid_manifest_and_is_immutable'
        'native_test_profile::tests::sites_access_refuses_foreign_production_and_non_https_destinations'
        'native_test_profile::tests::sites_access_refuses_invalid_missing_profiles_and_preexisting_header'
        'native_test_profile::tests::sites_access_preserves_site_paths_and_ordinary_tests_without_a_token'
        'account_cloud::sandbox_profile_tests::compiled_origin_is_shared_by_real_account_routes_and_portal'
        'license::sandbox_profile_tests::compiled_license_authority_is_one_key_and_kid_or_a_closed_error'
        'license::sandbox_profile_tests::real_refresh_url_uses_the_same_compiled_origin_without_transport_or_store'
    )
    foreach ($name in $selected) { if (-not $catalogue.Contains($name)) { throw 'A reviewed exact live-profile test is missing from the actual catalogue.' } }
    return [pscustomobject]@{CatalogueCount=$catalogue.Count; SelectedNames=$selected; ExpectedTotal=$selected.Count}
}

function Assert-ZentraLiveProfileSuite {
    param([Parameter(Mandatory=$true)]$Execution, [Parameter(Mandatory=$true)][string]$Name,
        [Parameter(Mandatory=$true)][int]$CatalogueCount, [Parameter(Mandatory=$true)][string]$Stdout,
        [Parameter(Mandatory=$true)][AllowEmptyString()][string]$Stderr, [Parameter(Mandatory=$true)][int]$Index)
    if ($Execution.filter -cne $Name -or $Execution.contextMode -cne 'diagnostics-verification' -or
        $Execution.stdout -cne ('windows-test-suite-{0:D2}.log' -f $Index) -or
        $Execution.stderr -cne ('windows-test-suite-{0:D2}-errors.log' -f $Index) -or
        (@($Execution.extraArguments) -join '|') -cne '--exact' -or
        (@($Execution.nativeArguments) -join '|') -cne ($Name + '|--test-threads=1|--exact')) { throw 'Live-profile suite identity or exact arguments differ.' }
    foreach ($field in @('exit','failed','ignored','selectedNames','passed')) {
        if ($Execution.$field -isnot [int] -and $Execution.$field -isnot [long]) { throw 'Live-profile suite counters must be actual integers.' }
    }
    if ($Execution.exit -ne 0 -or $Execution.failed -ne 0 -or $Execution.ignored -ne 0 -or $Execution.selectedNames -ne 1 -or $Execution.passed -ne 1 -or -not [string]::IsNullOrWhiteSpace($Stderr)) { throw 'The exact live-profile test did not pass cleanly.' }
    $summaries = [regex]::Matches($Stdout, '(?m)^test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured; (\d+) filtered out; finished in [0-9.]+s\r?$')
    $results = [regex]::Matches($Stdout, '(?m)^test ([A-Za-z_][A-Za-z0-9_:]*) \.\.\. (\S+)\r?$')
    $running = [regex]::Matches($Stdout, '(?m)^running 1 test\r?$')
    if ($summaries.Count -ne 1 -or $results.Count -ne 1 -or $running.Count -ne 1 -or
        [regex]::Matches($Stdout, '(?m)^test .*\r?$').Count -ne 2 -or [regex]::Matches($Stdout, '(?m)^running .*\r?$').Count -ne 1 -or
        $results[0].Groups[1].Value -cne $Name -or $results[0].Groups[2].Value -cne 'ok' -or
        [int]$summaries[0].Groups[1].Value -ne ($CatalogueCount - 1) -or
        $results[0].Index -le $running[0].Index -or $results[0].Index -ge $summaries[0].Index -or
        -not [string]::IsNullOrWhiteSpace($Stdout.Substring($summaries[0].Index + $summaries[0].Length))) { throw 'The exact live-profile log does not corroborate the real catalogue.' }
}

$admission = [ordered]@{}
foreach ($name in @('CIRCLECI','OS','CIRCLE_BRANCH','CIRCLE_SHA1','CIRCLE_NODE_INDEX','CIRCLE_NODE_TOTAL',
    'CIRCLE_WORKFLOW_ID','CIRCLE_BUILD_NUM','ZENTRA_LIVE_PROFILE_PIPELINE_ID','ZENTRA_VERIFY_DIAGNOSTICS_ONLY',
    'ZENTRA_VERIFY_ONLY','ZENTRA_VERIFY_NATIVE_PROFILE_ONLY','ZENTRA_VERIFY_LIVE_PROFILE_ONLY',
    'ZENTRA_LIVE_PROFILE_RELEASE','ZENTRA_DIAGNOSTICS_NATIVE_SET','RUSTUP_TOOLCHAIN','CARGO_TARGET_DIR',
    'ZENTRA_ACTION_NATIVE_TEST_CONTEXT','ZENTRA_ACTION_NATIVE_TEST_PROFILE_JSON',
    'ZENTRA_ACTION_NATIVE_TEST_PROFILE_SHA256','ZENTRA_ACTION_FULL_ARCHIVE_EVIDENCE')) {
    $admission[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
}
# No tool, artifact, environment mutation or bootstrap precedes this pure guard.
Assert-ZentraLiveProfileAdmission -Context $admission
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$source = $env:CIRCLE_SHA1
$head = @(& git -C $repo rev-parse HEAD)
if ($LASTEXITCODE -ne 0 -or $head.Count -ne 1 -or $head[0] -cne $source) { throw 'Live-profile HEAD must equal the exact CircleCI source.' }
$dirty = @(& git -C $repo status --porcelain --untracked-files=no)
if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw 'Live-profile tracked sources must be unchanged.' }
. (Join-Path $PSScriptRoot 'action-native-profile-verification.ps1')
. (Join-Path $PSScriptRoot 'windows-verification-harness.ps1')
$expectedSha = '2c23574986b6d87795a95c7a8a4ced270b396d0eba5160b5997b96faeb3693bf'
$fixturePath = Join-Path $repo 'desktop/tests/fixtures/action-native-live-a41-profile.public.json'
if ((Get-FileHash -LiteralPath $fixturePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne '2dbc44803bfbb886ede0e07637465bb3bb562c46392b971ec757939c99300ac0') { throw 'The exact public fixture emitted by the server preparer has changed.' }
$strictUtf8 = [Text.UTF8Encoding]::new($false,$true)
$fixture = Get-ZentraNativeProfileFixture -Json ($strictUtf8.GetString([IO.File]::ReadAllBytes($fixturePath))) -Sha256Text $expectedSha
if ($fixture.ExpectedPublicValues.siteOrigin -cne 'https://zentra-autopilote-recette-a41-20261013.alb-leart1.chatgpt.site' -or
    $fixture.ExpectedPublicValues.supabaseOrigin -cne 'https://lanhvwpalnkuabtjcpgp.supabase.co') { throw 'The fixture must identify only the approved live sandbox destination.' }
$artifacts = Join-Path $repo 'desktop/artifacts/action-live-profile'
if (Test-Path -LiteralPath $artifacts) { throw 'Live-profile artifacts must use a fresh distinct directory.' }
$savedEnvironment = [ordered]@{}
foreach ($name in @('PATH','CARGO_PROFILE_TEST_DEBUG','ZENTRA_ACTION_NATIVE_TEST_CONTEXT','ZENTRA_ACTION_NATIVE_TEST_PROFILE_JSON','ZENTRA_ACTION_NATIVE_TEST_PROFILE_SHA256')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
}
$proof = [ordered]@{
    kind='live-sandbox-a41-native-profile-verification';schemaVersion=1;source=$source;circleSource=$source
    pipelineId=$env:ZENTRA_LIVE_PROFILE_PIPELINE_ID;workflowId=$env:CIRCLE_WORKFLOW_ID;jobNumber=$env:CIRCLE_BUILD_NUM
    nodeIndex=0;nodeTotal=1;context='live-sandbox-a41';branch=$env:CIRCLE_BRANCH;verificationOnly=$true
    compileNoRun=$true;compileInputManifestSha256=$expectedSha;expectedPublicValues=$fixture.ExpectedPublicValues
    fixture='desktop/tests/fixtures/action-native-live-a41-profile.public.json'
    fixtureBytesSha256=(Get-FileHash -LiteralPath $fixturePath -Algorithm SHA256).Hash.ToLowerInvariant()
    catalogueCount=$null;selectedNames=@();suiteExecutions=@();expectedTotal=11;runtimePassed=0;passed=$false
    bootstrap=$null;binarySha256=$null;applicationAuthorityValidated=$false;nativeBusinessJourneyExecuted=$false
    historicalA33EvidenceModified=$false;packagingExecuted=$false;signingExecuted=$false;publishesRelease=$false
    startedAt=[DateTimeOffset]::UtcNow.ToString('o');completedAt=$null
}
try {
    [IO.Directory]::CreateDirectory($artifacts) | Out-Null
    $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
    $env:CARGO_PROFILE_TEST_DEBUG = '0'
    $bootstrap = [ordered]@{required=$null;checksumVerified=$false;actualInstallerSha256=$null;expectedInstallerSha256=$null;installerExit=$null;complete=$false}
    try {
        $candidates = @(Get-Command rustup -CommandType Application -ErrorAction SilentlyContinue)
        $bootstrapPlan = Get-ZentraNativeProfileRustupBootstrapPlan -ApplicationCount $candidates.Count
        $bootstrap.required = $bootstrapPlan.Required
        if ($bootstrapPlan.Required) {
            $bootstrapDirectory = Join-Path $artifacts 'bootstrap'
            [IO.Directory]::CreateDirectory($bootstrapDirectory) | Out-Null
            $installer = Join-Path $bootstrapDirectory 'rustup-init.exe'
            $checksum = Join-Path $bootstrapDirectory 'rustup-init.exe.sha256'
            Invoke-WebRequest -UseBasicParsing -Uri $bootstrapPlan.InstallerUri -OutFile $installer -TimeoutSec $bootstrapPlan.RequestTimeoutSeconds -MaximumRedirection $bootstrapPlan.MaximumRedirections
            if ((Get-Item -LiteralPath $installer).Length -le 0 -or (Get-Item -LiteralPath $installer).Length -gt $bootstrapPlan.MaximumInstallerBytes) { throw 'The official Rustup installer exceeds its bounds.' }
            Invoke-WebRequest -UseBasicParsing -Uri $bootstrapPlan.ChecksumUri -OutFile $checksum -TimeoutSec $bootstrapPlan.RequestTimeoutSeconds -MaximumRedirection $bootstrapPlan.MaximumRedirections
            if ((Get-Item -LiteralPath $checksum).Length -le 0 -or (Get-Item -LiteralPath $checksum).Length -gt $bootstrapPlan.MaximumChecksumBytes) { throw 'The official Rustup checksum exceeds its bounds.' }
            $bootstrap.expectedInstallerSha256 = Get-ZentraNativeProfileRustupChecksum -Text ($strictUtf8.GetString([IO.File]::ReadAllBytes($checksum)))
            $installer = Select-ZentraHarnessApplication @([pscustomobject]@{Source=$installer})
            $bootstrap.actualInstallerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
            Assert-ZentraNativeProfileRustupChecksum -Expected $bootstrap.expectedInstallerSha256 -Actual $bootstrap.actualInstallerSha256
            $bootstrap.checksumVerified = $true
            $bootstrap.installerExit = Invoke-ZentraHarnessTool $installer $bootstrapPlan.InstallerArguments $repo (Join-Path $bootstrapDirectory 'rustup-install.log') (Join-Path $bootstrapDirectory 'rustup-install-errors.log') -TimeoutSeconds $bootstrapPlan.InstallerTimeoutSeconds
            if ($bootstrap.installerExit -ne 0) { throw 'The official Rustup bootstrap failed.' }
            $candidates = @(Get-Command rustup -CommandType Application -ErrorAction SilentlyContinue)
        }
        $rustup = Select-ZentraHarnessApplication $candidates
        if ([IO.Path]::GetFileName($rustup) -cne 'rustup.exe') { throw 'The CI vendor resolver must be rustup.exe.' }
        $bootstrap.complete = $true
    } finally { $proof.bootstrap = $bootstrap; Save-ZentraHarnessProof $bootstrap (Join-Path $artifacts 'live-profile-bootstrap-proof.json') }
    $toolchainExit = Invoke-ZentraHarnessTool $rustup @('toolchain','install',$env:RUSTUP_TOOLCHAIN,'--profile','minimal') $repo (Join-Path $artifacts 'toolchain-install.log') (Join-Path $artifacts 'toolchain-install-errors.log') -TimeoutSeconds 1800
    if ($toolchainExit -ne 0) { throw 'Could not prepare the isolated MSVC test toolchain.' }
    $env:ZENTRA_ACTION_NATIVE_TEST_CONTEXT = 'live-sandbox-a41'
    $env:ZENTRA_ACTION_NATIVE_TEST_PROFILE_JSON = $fixture.Json
    $env:ZENTRA_ACTION_NATIVE_TEST_PROFILE_SHA256 = $expectedSha
    $harness = Initialize-ZentraVerificationHarness $repo $artifacts $source
    $plan = Get-ZentraLiveProfilePlan -TestNames $harness.TestNames
    $proof.catalogueCount = $plan.CatalogueCount
    $proof.selectedNames = $plan.SelectedNames
    $proof.binarySha256 = $harness.ExpectedSha256
    for ($index = 0; $index -lt $plan.SelectedNames.Count; $index++) {
        $name = $plan.SelectedNames[$index]
        Invoke-ZentraVerificationSuite $harness $name @('--exact')
        $execution = $harness.Proof.suiteExecutions[$index]
        Assert-ZentraLiveProfileSuite -Execution $execution -Name $name -CatalogueCount $plan.CatalogueCount -Index ($index + 1) `
            -Stdout ([IO.File]::ReadAllText((Join-Path $artifacts ('windows-test-suite-{0:D2}.log' -f ($index + 1))))) `
            -Stderr ([IO.File]::ReadAllText((Join-Path $artifacts ('windows-test-suite-{0:D2}-errors.log' -f ($index + 1)))))
        $proof.runtimePassed++
    }
    if ($proof.runtimePassed -ne 11 -or $harness.Proof.suiteExecutions.Count -ne 11) { throw 'The one-node live-profile result is incomplete.' }
    . (Join-Path $PSScriptRoot 'quote-autopilot-verification.ps1')
    $autopilotProof = Invoke-ZentraAutopilotProductVerification -Harness $harness -Source $source -ProfileSha256 $expectedSha -Artifacts $artifacts
    if (-not $autopilotProof.passed) { throw 'Autopilot product native validation did not pass.' }
    $proof.passed = $true
    Write-Host "LIVE_PROFILE_PASSED source=$source context=live-sandbox-a41 passed=$($proof.runtimePassed)"
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name,$savedEnvironment[$name],'Process') }
    if (Test-Path -LiteralPath $artifacts -PathType Container) {
        if (Test-Path -LiteralPath (Join-Path $artifacts 'windows-test-harness-proof.json')) {
            $harnessRecord = [IO.File]::ReadAllText((Join-Path $artifacts 'windows-test-harness-proof.json')) | ConvertFrom-Json
            # This historical proof continues to describe only its eleven
            # profile tests. The additional nine have their own closed receipt.
            $proof.suiteExecutions = @($harnessRecord.suiteExecutions | Select-Object -First 11)
        }
        $proof.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
        Save-ZentraHarnessProof $proof (Join-Path $artifacts 'live-profile-verification-proof.json')
        # Reuse the reviewed bounded inventory; a distinct ZIP preserves empty
        # stderr files that a provider's individual-file artifact view may omit.
        $inventory = @(Get-ZentraNativeProfileTransportInventory -NodePath $artifacts)
        if ($inventory.Count -eq 0 -or ($inventory | Measure-Object bytes -Sum).Sum -gt 268435456) { throw 'The live-profile evidence inventory exceeds its bound.' }
        Add-Type -AssemblyName System.IO.Compression
        $bundlePath = Join-Path $artifacts 'live-profile-evidence.zip'
        $bundleStream = [IO.FileStream]::new($bundlePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        $archive = $null
        $transportFiles = @()
        try {
            $archive = [IO.Compression.ZipArchive]::new($bundleStream,[IO.Compression.ZipArchiveMode]::Create,$true)
            foreach ($file in $inventory) {
                $before = (Get-FileHash -LiteralPath $file.fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
                $entry = $archive.CreateEntry($file.path,[IO.Compression.CompressionLevel]::Optimal)
                $destination = $entry.Open()
                $inputStream = [IO.File]::OpenRead($file.fullPath)
                try { $inputStream.CopyTo($destination) } finally { $inputStream.Dispose(); $destination.Dispose() }
                if ((Get-Item -LiteralPath $file.fullPath).Length -ne $file.bytes -or (Get-FileHash -LiteralPath $file.fullPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $before) { throw 'Live-profile evidence changed during capture.' }
                $transportFiles += [ordered]@{path=$file.path;bytes=$file.bytes;sha256=$before}
            }
        } finally { if ($null -ne $archive) { $archive.Dispose() }; $bundleStream.Dispose() }
        Save-ZentraHarnessProof ([ordered]@{
            kind='live-sandbox-a41-native-profile-transport';schemaVersion=1;source=$source;context='live-sandbox-a41';nodeIndex=0;nodeTotal=1
            pipelineId=$env:ZENTRA_LIVE_PROFILE_PIPELINE_ID;workflowId=$env:CIRCLE_WORKFLOW_ID;jobNumber=$env:CIRCLE_BUILD_NUM
            files=$transportFiles;fileCount=$transportFiles.Count
            zip=[ordered]@{path='live-profile-evidence.zip';bytes=(Get-Item -LiteralPath $bundlePath).Length;sha256=(Get-FileHash -LiteralPath $bundlePath -Algorithm SHA256).Hash.ToLowerInvariant()}
        }) (Join-Path $artifacts 'live-profile-transport-receipt.json')
    }
}
