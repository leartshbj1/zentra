# Separate, opt-in CI recipe. Never call this script to perform local checks.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'action-native-profile-verification.ps1')
$admission = [ordered]@{}
foreach ($name in @('CIRCLECI','OS','CIRCLE_BRANCH','CIRCLE_SHA1','ZENTRA_VERIFY_DIAGNOSTICS_ONLY',
    'ZENTRA_VERIFY_ONLY','ZENTRA_VERIFY_NATIVE_PROFILE_ONLY','ZENTRA_NATIVE_PROFILE_RELEASE',
    'ZENTRA_DIAGNOSTICS_NATIVE_SET','RUSTUP_TOOLCHAIN','CARGO_TARGET_DIR',
    'CIRCLE_NODE_INDEX','CIRCLE_NODE_TOTAL','CIRCLE_WORKFLOW_ID','CIRCLE_BUILD_NUM',
    'ZENTRA_NATIVE_PROFILE_PIPELINE_ID')) {
    $admission[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
}
# This pure guard precedes environment changes, artifact creation and bootstrap.
Assert-ZentraNativeProfileAdmission -Context $admission
$node = Get-ZentraNativeProfileNodePlan -Context $admission
$context = $node.Context
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$source = $env:CIRCLE_SHA1
$head = @(& git -C $repo rev-parse HEAD)
if ($LASTEXITCODE -ne 0 -or $head.Count -ne 1 -or $head[0] -cne $source) {
    throw 'Native profile verification requires HEAD to equal the exact CircleCI source.'
}
Write-Host "NATIVE_PROFILE_NODE source=$source pipeline=$($node.PipelineId) workflow=$($node.WorkflowId) job=$($node.JobNumber) index=$($node.NodeIndex) total=$($node.NodeTotal) context=$context expected=$($node.ExpectedTotal)"
$fixturePath = Join-Path $repo 'desktop/tests/fixtures/action-native-test-profile.public.json'
$fixtureShaPath = Join-Path $repo 'desktop/tests/fixtures/action-native-test-profile.public.sha256'
$strictUtf8 = [Text.UTF8Encoding]::new($false,$true)
# Decode the original bytes without ReadAllText's automatic BOM removal.
$fixture = Get-ZentraNativeProfileFixture -Json ($strictUtf8.GetString([IO.File]::ReadAllBytes($fixturePath))) -Sha256Text ($strictUtf8.GetString([IO.File]::ReadAllBytes($fixtureShaPath)))
$artifactRoot = Join-Path $repo 'desktop/artifacts/action-native-profile'
if (Test-Path -LiteralPath $artifactRoot) { throw 'Native profile artifacts must use a fresh, distinct directory.' }
$artifacts = Join-Path $artifactRoot $node.ArtifactDirectory
$savedEnvironment = [ordered]@{}
foreach ($name in @('ZENTRA_ACTION_NATIVE_TEST_PROFILE_JSON','ZENTRA_ACTION_NATIVE_TEST_PROFILE_SHA256',
    'ZENTRA_ACTION_FULL_ARCHIVE_EVIDENCE','PATH','CARGO_PROFILE_TEST_DEBUG')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
}
$proof = [ordered]@{
    kind='isolated-native-test-profile-node-verification'; schemaVersion=1; source=$source; circleSource=$env:CIRCLE_SHA1
    pipelineId=$node.PipelineId; workflowId=$node.WorkflowId; jobNumber=$node.JobNumber
    nodeIndex=$node.NodeIndex; nodeTotal=$node.NodeTotal; context=$context
    branch=$env:CIRCLE_BRANCH; verificationOnly=$true; data='synthetic'; target='x86_64-pc-windows-msvc'
    fixture='desktop/tests/fixtures/action-native-test-profile.public.json'
    fixtureBytesSha256=(Get-FileHash -LiteralPath $fixturePath -Algorithm SHA256).Hash.ToLowerInvariant()
    expectedManifestSha256=$fixture.Sha256; expectedPublicValues=$fixture.ExpectedPublicValues
    expectedTotal=$node.ExpectedTotal; contextEvidence=$null; contextPassed=$false; runtimePassed=0
    aggregationExecuted=$false
    bootstrap=$null
    toolchain=[ordered]@{name=$env:RUSTUP_TOOLCHAIN;exit=$null;prepared=$false;stdout='toolchain-install.log';stderr='toolchain-install-errors.log'}
    fullArchiveInteropExecuted=$false; historicalG0EvidenceModified=$false
    frontendExecuted=$false; packagingExecuted=$false; signingExecuted=$false
    publishesInstaller=$false; publishesRelease=$false; installsApplication=$false
    startedAt=[DateTimeOffset]::UtcNow.ToString('o'); completedAt=$null
}
try {
    [IO.Directory]::CreateDirectory($artifacts) | Out-Null
    . (Join-Path $PSScriptRoot 'windows-verification-harness.ps1')
    $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
    $env:CARGO_PROFILE_TEST_DEBUG = '0'
    # A missing image dependency permits only the official, checksum-verified
    # Rustup bootstrap. A present invalid candidate still refuses unchanged.
    $bootstrapProof = [ordered]@{
        required=$null; candidatesBefore=@(); installerUri=$null; checksumUri=$null
        requestTimeoutSeconds=$null; maximumRedirections=$null
        installerDownloadCompleted=$false; checksumDownloadCompleted=$false
        installerBytes=$null; checksumBytes=$null; checksumDocumentSha256=$null
        expectedInstallerSha256=$null; actualInstallerSha256=$null; checksumVerified=$false
        installerArguments=@(); installerTimeoutSeconds=$null; installerExit=$null
        candidatesAfter=@(); resolvedRustup=$null; complete=$false
    }
    try {
        $rustupCandidates = @(Get-Command rustup -CommandType Application -ErrorAction SilentlyContinue)
        $bootstrapPlan = Get-ZentraNativeProfileRustupBootstrapPlan -ApplicationCount $rustupCandidates.Count
        $bootstrapProof.required = $bootstrapPlan.Required
        $bootstrapProof.candidatesBefore = @(Get-ZentraHarnessApplicationMetadata $rustupCandidates)
        if ($bootstrapPlan.Required) {
            $bootstrapArtifacts = Join-Path $artifacts 'bootstrap'
            [IO.Directory]::CreateDirectory($bootstrapArtifacts) | Out-Null
            $installer = Join-Path $bootstrapArtifacts 'rustup-init.exe'
            $checksumPath = Join-Path $bootstrapArtifacts 'rustup-init.exe.sha256'
            $bootstrapProof.installerUri = $bootstrapPlan.InstallerUri
            $bootstrapProof.checksumUri = $bootstrapPlan.ChecksumUri
            $bootstrapProof.requestTimeoutSeconds = $bootstrapPlan.RequestTimeoutSeconds
            $bootstrapProof.maximumRedirections = $bootstrapPlan.MaximumRedirections
            Invoke-WebRequest -UseBasicParsing -Uri $bootstrapPlan.InstallerUri -OutFile $installer `
                -TimeoutSec $bootstrapPlan.RequestTimeoutSeconds -MaximumRedirection $bootstrapPlan.MaximumRedirections
            $bootstrapProof.installerDownloadCompleted = $true
            $bootstrapProof.installerBytes = (Get-Item -LiteralPath $installer).Length
            if ($bootstrapProof.installerBytes -le 0 -or
                $bootstrapProof.installerBytes -gt $bootstrapPlan.MaximumInstallerBytes) { throw 'The official Rustup installer download is empty, oversized or unsuccessful.' }
            Invoke-WebRequest -UseBasicParsing -Uri $bootstrapPlan.ChecksumUri -OutFile $checksumPath `
                -TimeoutSec $bootstrapPlan.RequestTimeoutSeconds -MaximumRedirection $bootstrapPlan.MaximumRedirections
            $bootstrapProof.checksumDownloadCompleted = $true
            $bootstrapProof.checksumBytes = (Get-Item -LiteralPath $checksumPath).Length
            if ($bootstrapProof.checksumBytes -le 0 -or
                $bootstrapProof.checksumBytes -gt $bootstrapPlan.MaximumChecksumBytes) { throw 'The official Rustup checksum download is empty, oversized or unsuccessful.' }
            $bootstrapProof.checksumDocumentSha256 = (Get-FileHash -LiteralPath $checksumPath -Algorithm SHA256).Hash.ToLowerInvariant()
            $bootstrapProof.expectedInstallerSha256 = Get-ZentraNativeProfileRustupChecksum -Text ($strictUtf8.GetString([IO.File]::ReadAllBytes($checksumPath)))
            $installer = Select-ZentraHarnessApplication @([pscustomobject]@{Source=$installer})
            $bootstrapProof.actualInstallerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
            Assert-ZentraNativeProfileRustupChecksum -Expected $bootstrapProof.expectedInstallerSha256 -Actual $bootstrapProof.actualInstallerSha256
            $bootstrapProof.checksumVerified = $true
            $bootstrapProof.installerArguments = $bootstrapPlan.InstallerArguments
            $bootstrapProof.installerTimeoutSeconds = $bootstrapPlan.InstallerTimeoutSeconds
            $bootstrapProof.installerExit = Invoke-ZentraHarnessTool $installer $bootstrapPlan.InstallerArguments $repo `
                (Join-Path $bootstrapArtifacts 'rustup-install.log') (Join-Path $bootstrapArtifacts 'rustup-install-errors.log') `
                -HeartbeatMessage 'Installing only the checksum-verified official Rustup dependency.' -TimeoutSeconds $bootstrapPlan.InstallerTimeoutSeconds
            if ($bootstrapProof.installerExit -ne 0) { throw 'The official Rustup bootstrap did not exit successfully.' }
            $rustupCandidates = @(Get-Command rustup -CommandType Application -ErrorAction SilentlyContinue)
        }
        $bootstrapProof.candidatesAfter = @(Get-ZentraHarnessApplicationMetadata $rustupCandidates)
        $rustup = Select-ZentraHarnessApplication $rustupCandidates
        if ([IO.Path]::GetFileName($rustup) -cne 'rustup.exe') { throw 'The installed CI vendor resolver must be rustup.exe.' }
        $bootstrapProof.resolvedRustup = [ordered]@{path=$rustup;sha256=(Get-FileHash -LiteralPath $rustup -Algorithm SHA256).Hash.ToLowerInvariant()}
        $bootstrapProof.complete = $true
    } finally {
        $proof.bootstrap = $bootstrapProof
        Save-ZentraHarnessProof $bootstrapProof (Join-Path $artifacts 'native-profile-bootstrap-proof.json')
    }
    $toolchainExit = Invoke-ZentraHarnessTool $rustup @('toolchain','install',$env:RUSTUP_TOOLCHAIN,'--profile','minimal') $repo `
        (Join-Path $artifacts 'toolchain-install.log') (Join-Path $artifacts 'toolchain-install-errors.log') `
        -HeartbeatMessage 'Preparing only the MSVC library test toolchain.' -TimeoutSeconds 1800
    $proof.toolchain.exit = $toolchainExit
    if ($toolchainExit -ne 0) { throw 'Could not prepare the isolated native profile test toolchain.' }
    $proof.toolchain.prepared = $true
    # A node compiles exactly one admitted context. Other nodes are never
    # read here; their identities/catalogues/results need offline aggregation.
    $contextArtifacts = $artifacts
    [Environment]::SetEnvironmentVariable('ZENTRA_ACTION_NATIVE_TEST_PROFILE_JSON', $null, 'Process')
    [Environment]::SetEnvironmentVariable('ZENTRA_ACTION_NATIVE_TEST_PROFILE_SHA256', $null, 'Process')
    [Environment]::SetEnvironmentVariable('ZENTRA_ACTION_FULL_ARCHIVE_EVIDENCE', $null, 'Process')
    if ($context -cne 'absent') { $env:ZENTRA_ACTION_NATIVE_TEST_PROFILE_JSON = $fixture.Json }
    if ($context -ceq 'sandbox') { $env:ZENTRA_ACTION_NATIVE_TEST_PROFILE_SHA256 = $fixture.Sha256 }
    if ($context -ceq 'absent') { $env:ZENTRA_ACTION_FULL_ARCHIVE_EVIDENCE = Join-Path $contextArtifacts 'action-engine-interop' }
    $contextProof = [ordered]@{
        kind='isolated-native-test-profile-context-verification'; schemaVersion=1; source=$source
        pipelineId=$node.PipelineId; workflowId=$node.WorkflowId; jobNumber=$node.JobNumber
        nodeIndex=$node.NodeIndex; nodeTotal=$node.NodeTotal; expectedTotal=$node.ExpectedTotal
        context=$context; jsonInputPresent=($context -cne 'absent'); sha256InputPresent=($context -ceq 'sandbox')
        expectedConfiguredResult=$(if ($context -ceq 'absent') {'unconfigured'} elseif ($context -ceq 'sandbox') {'sandbox'} else {'refused'})
        expectedPublicValues=$(if ($context -ceq 'sandbox') {$fixture.ExpectedPublicValues} else {$null})
        compileInputJsonBytesSha256=$(if ($context -cne 'absent') {$proof.fixtureBytesSha256} else {$null})
        compileInputManifestSha256=$(if ($context -ceq 'sandbox') {$fixture.Sha256} else {$null})
        compiledContextAssertion='native_test_profile::tests::absent_compilation_inputs_are_unconfigured_and_partial_inputs_refuse'
        nativeHarnessProof='windows-test-harness-proof.json'; catalogueCount=$null; profileTestNames=@(); selectedNames=@(); suiteExecutions=@()
        binarySha256=$null; runtimePassed=0; passed=$false
        nativeArchiveExported=$false; nativeArchiveInteropExecuted=$false
    }
    try {
        $harness = Initialize-ZentraVerificationHarness $repo $contextArtifacts $source
        $plan = Get-ZentraNativeProfileVerificationPlan -TestNames $harness.TestNames -IncludeActionEngine:($context -ceq 'absent')
        if ($plan.ExpectedTotal -ne $node.ExpectedTotal) { throw 'The admitted node catalogue has a different selected count.' }
        $contextProof.catalogueCount = $plan.CatalogueCount
        $contextProof.profileTestNames = $plan.ProfileTestNames
        $contextProof.selectedNames = $plan.SelectedTestNames
        $contextProof.binarySha256 = $harness.ExpectedSha256
        foreach ($filter in $plan.Filters) { Invoke-ZentraVerificationSuite $harness $filter.Name $filter.Arguments }
        $contextProof.suiteExecutions = $harness.Proof.suiteExecutions
        $stdoutTexts = @()
        $stderrTexts = @()
        for ($index = 1; $index -le $plan.Filters.Count; $index++) {
            # Read calculated fixed filenames, never paths supplied by proof.
            $stdoutTexts += [IO.File]::ReadAllText((Join-Path $contextArtifacts ('windows-test-suite-{0:D2}.log' -f $index)))
            $stderrTexts += [IO.File]::ReadAllText((Join-Path $contextArtifacts ('windows-test-suite-{0:D2}-errors.log' -f $index)))
        }
        $corroboration = Assert-ZentraNativeProfileVerificationProof -Plan $plan -SuiteExecutions $harness.Proof.suiteExecutions -StdoutTexts $stdoutTexts -StderrTexts $stderrTexts
        if ($context -ceq 'absent') {
            foreach ($name in @('synthetic-quote.zentra','synthetic-quote-metadata.json')) {
                if (-not [IO.File]::Exists((Join-Path $env:ZENTRA_ACTION_FULL_ARCHIVE_EVIDENCE $name))) { throw 'The separate absent-context synthetic archive was not exported.' }
            }
            $contextProof.nativeArchiveExported = $true
        }
        $contextProof.corroboration = $corroboration
        $contextProof.runtimePassed = $corroboration.TotalPassed
        $contextProof.passed = $true
        $proof.runtimePassed = $corroboration.TotalPassed
    } finally {
        # The existing harness saves its failure record independently.
        if (Test-Path -LiteralPath (Join-Path $contextArtifacts 'windows-test-harness-proof.json')) {
            $record = [IO.File]::ReadAllText((Join-Path $contextArtifacts 'windows-test-harness-proof.json')) | ConvertFrom-Json
            $contextProof.suiteExecutions = @($record.suiteExecutions)
        }
        Save-ZentraHarnessProof $contextProof (Join-Path $contextArtifacts 'native-profile-context-proof.json')
        $proof.contextEvidence = $contextProof
    }
    if ($proof.runtimePassed -ne $node.ExpectedTotal -or -not $contextProof.passed) { throw 'The single admitted native profile context is incomplete.' }
    $proof.contextPassed = $true
    Write-Host "NATIVE_PROFILE_NODE_PASSED job=$($node.JobNumber) index=$($node.NodeIndex) total=$($node.NodeTotal) context=$context passed=$($proof.runtimePassed) aggregationExecuted=false"
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name,$savedEnvironment[$name],'Process') }
    $proof.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    if (Test-Path -LiteralPath $artifacts -PathType Container) { Save-ZentraHarnessProof $proof (Join-Path $artifacts 'native-profile-verification-proof.json') }
}
