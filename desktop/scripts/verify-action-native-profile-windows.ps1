# Separate, opt-in CI recipe. Never call this script to perform local checks.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'action-native-profile-verification.ps1')
$admission = [ordered]@{}
foreach ($name in @('CIRCLECI','OS','CIRCLE_BRANCH','CIRCLE_SHA1','ZENTRA_VERIFY_DIAGNOSTICS_ONLY',
    'ZENTRA_VERIFY_ONLY','ZENTRA_VERIFY_NATIVE_PROFILE_ONLY','ZENTRA_NATIVE_PROFILE_RELEASE',
    'ZENTRA_DIAGNOSTICS_NATIVE_SET','RUSTUP_TOOLCHAIN','CARGO_TARGET_DIR')) {
    $admission[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
}
# This pure guard precedes environment changes, artifact creation and bootstrap.
Assert-ZentraNativeProfileAdmission -Context $admission
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$source = $env:CIRCLE_SHA1
$head = @(& git -C $repo rev-parse HEAD)
if ($LASTEXITCODE -ne 0 -or $head.Count -ne 1 -or $head[0] -cne $source) {
    throw 'Native profile verification requires HEAD to equal the exact CircleCI source.'
}
$fixturePath = Join-Path $repo 'desktop/tests/fixtures/action-native-test-profile.public.json'
$fixtureShaPath = Join-Path $repo 'desktop/tests/fixtures/action-native-test-profile.public.sha256'
$strictUtf8 = [Text.UTF8Encoding]::new($false,$true)
# Decode the original bytes without ReadAllText's automatic BOM removal.
$fixture = Get-ZentraNativeProfileFixture -Json ($strictUtf8.GetString([IO.File]::ReadAllBytes($fixturePath))) -Sha256Text ($strictUtf8.GetString([IO.File]::ReadAllBytes($fixtureShaPath)))
$artifacts = Join-Path $repo 'desktop/artifacts/action-native-profile'
if (Test-Path -LiteralPath $artifacts) { throw 'Native profile artifacts must use a fresh, distinct directory.' }
$savedEnvironment = [ordered]@{}
foreach ($name in @('ZENTRA_ACTION_NATIVE_TEST_PROFILE_JSON','ZENTRA_ACTION_NATIVE_TEST_PROFILE_SHA256',
    'ZENTRA_ACTION_FULL_ARCHIVE_EVIDENCE','PATH','CARGO_PROFILE_TEST_DEBUG')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
}
$proof = [ordered]@{
    kind='isolated-native-test-profile-verification'; source=$source; circleSource=$env:CIRCLE_SHA1
    branch=$env:CIRCLE_BRANCH; verificationOnly=$true; data='synthetic'; target='x86_64-pc-windows-msvc'
    fixture='desktop/tests/fixtures/action-native-test-profile.public.json'
    fixtureBytesSha256=(Get-FileHash -LiteralPath $fixturePath -Algorithm SHA256).Hash.ToLowerInvariant()
    expectedManifestSha256=$fixture.Sha256; expectedPublicValues=$fixture.ExpectedPublicValues
    expectedContextCounts=[ordered]@{absent=265;sandbox=26;partial=26}; expectedTotal=317
    contexts=@(); allContextsPassed=$false; runtimePassed=0
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
    # The Windows image must supply the installed vendor resolver. There is no
    # fallback installer, frontend bootstrap, packaging or application launch.
    $rustup = Select-ZentraHarnessApplication @(Get-Command rustup -CommandType Application -ErrorAction SilentlyContinue)
    if ([IO.Path]::GetFileName($rustup) -cne 'rustup.exe') { throw 'The CI image must provide the installed rustup.exe vendor resolver.' }
    $toolchainExit = Invoke-ZentraHarnessTool $rustup @('toolchain','install',$env:RUSTUP_TOOLCHAIN,'--profile','minimal') $repo `
        (Join-Path $artifacts 'toolchain-install.log') (Join-Path $artifacts 'toolchain-install-errors.log') `
        -HeartbeatMessage 'Preparing only the MSVC library test toolchain.' -TimeoutSeconds 1800
    if ($toolchainExit -ne 0) { throw 'Could not prepare the isolated native profile test toolchain.' }
    $hashes = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $profileCatalogue = $null
    foreach ($context in @('absent','sandbox','partial')) {
        $contextArtifacts = Join-Path $artifacts $context
        [IO.Directory]::CreateDirectory($contextArtifacts) | Out-Null
        [Environment]::SetEnvironmentVariable('ZENTRA_ACTION_NATIVE_TEST_PROFILE_JSON', $null, 'Process')
        [Environment]::SetEnvironmentVariable('ZENTRA_ACTION_NATIVE_TEST_PROFILE_SHA256', $null, 'Process')
        [Environment]::SetEnvironmentVariable('ZENTRA_ACTION_FULL_ARCHIVE_EVIDENCE', $null, 'Process')
        if ($context -cne 'absent') { $env:ZENTRA_ACTION_NATIVE_TEST_PROFILE_JSON = $fixture.Json }
        if ($context -ceq 'sandbox') { $env:ZENTRA_ACTION_NATIVE_TEST_PROFILE_SHA256 = $fixture.Sha256 }
        if ($context -ceq 'absent') { $env:ZENTRA_ACTION_FULL_ARCHIVE_EVIDENCE = Join-Path $contextArtifacts 'action-engine-interop' }
        $contextProof = [ordered]@{
            context=$context; jsonInputPresent=($context -cne 'absent'); sha256InputPresent=($context -ceq 'sandbox')
            expectedConfiguredResult=$(if ($context -ceq 'absent') {'unconfigured'} elseif ($context -ceq 'sandbox') {'sandbox'} else {'refused'})
            expectedPublicValues=$(if ($context -ceq 'sandbox') {$fixture.ExpectedPublicValues} else {$null})
            compileInputJsonBytesSha256=$(if ($context -cne 'absent') {$proof.fixtureBytesSha256} else {$null})
            compileInputManifestSha256=$(if ($context -ceq 'sandbox') {$fixture.Sha256} else {$null})
            compiledContextAssertion='native_test_profile::tests::absent_compilation_inputs_are_unconfigured_and_partial_inputs_refuse'
            nativeHarnessProof='windows-test-harness-proof.json'; selectedNames=@(); suiteExecutions=@()
            binarySha256=$null; runtimePassed=0; passed=$false
            nativeArchiveExported=$false; nativeArchiveInteropExecuted=$false
        }
        try {
            $harness = Initialize-ZentraVerificationHarness $repo $contextArtifacts $source
            $plan = Get-ZentraNativeProfileVerificationPlan -TestNames $harness.TestNames -IncludeActionEngine:($context -ceq 'absent')
            $names = $plan.ProfileTestNames -join "`n"
            if ($null -ne $profileCatalogue -and $profileCatalogue -cne $names) { throw 'The three compiled profile catalogues differ.' }
            $profileCatalogue = $names
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
            if (-not $hashes.Add($harness.ExpectedSha256)) { throw 'The three compiled contexts must have distinct harness hashes; hashes alone do not prove profile routing.' }
            if ($context -ceq 'absent') {
                foreach ($name in @('synthetic-quote.zentra','synthetic-quote-metadata.json')) {
                    if (-not [IO.File]::Exists((Join-Path $env:ZENTRA_ACTION_FULL_ARCHIVE_EVIDENCE $name))) { throw 'The separate absent-context synthetic archive was not exported.' }
                }
                $contextProof.nativeArchiveExported = $true
            }
            $contextProof.corroboration = $corroboration
            $contextProof.runtimePassed = $corroboration.TotalPassed
            $contextProof.passed = $true
            $proof.runtimePassed += $corroboration.TotalPassed
        } finally {
            # The existing harness saves its failure record independently.
            if (Test-Path -LiteralPath (Join-Path $contextArtifacts 'windows-test-harness-proof.json')) {
                $record = [IO.File]::ReadAllText((Join-Path $contextArtifacts 'windows-test-harness-proof.json')) | ConvertFrom-Json
                $contextProof.suiteExecutions = @($record.suiteExecutions)
            }
            Save-ZentraHarnessProof $contextProof (Join-Path $contextArtifacts 'native-profile-context-proof.json')
            $proof.contexts += $contextProof
        }
    }
    if ($proof.runtimePassed -ne 317 -or $hashes.Count -ne 3 -or $proof.contexts.Count -ne 3) { throw 'The three native profile contexts are incomplete.' }
    $proof.allContextsPassed = $true
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name,$savedEnvironment[$name],'Process') }
    $proof.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    if (Test-Path -LiteralPath $artifacts -PathType Container) { Save-ZentraHarnessProof $proof (Join-Path $artifacts 'native-profile-verification-proof.json') }
}
