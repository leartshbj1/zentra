# Pure PS behavior/AST and a managed ZIP of small synthetic text files only.
# SYNTHETIC results never attest native execution. The CI runner is parsed, never run.
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
    CIRCLE_NODE_INDEX='0';CIRCLE_NODE_TOTAL='3';CIRCLE_BUILD_NUM='302'
    ZENTRA_NATIVE_PROFILE_PIPELINE_ID='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    CIRCLE_WORKFLOW_ID='11111111-2222-3333-4444-555555555555'
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
foreach ($spec in @(
    @{Index='0';Name='absent';Count=271},
    @{Index='1';Name='sandbox';Count=32},
    @{Index='2';Name='partial';Count=32}
)) {
    $copy = [ordered]@{}
    foreach ($key in $context.Keys) { $copy[$key] = $context[$key] }
    $copy['CIRCLE_NODE_INDEX'] = $spec.Index
    $null = Assert-ZentraNativeProfileAdmission $copy
    $node = Get-ZentraNativeProfileNodePlan $copy
    Assert-Behavior ($node.Context -ceq $spec.Name -and $node.NodeIndex -eq [int]$spec.Index -and
        $node.NodeTotal -eq 3 -and $node.ExpectedTotal -eq $spec.Count -and
        $node.ArtifactDirectory -ceq "node-$($spec.Index)-$($spec.Name)" -and
        $node.PipelineId -ceq $context['ZENTRA_NATIVE_PROFILE_PIPELINE_ID'] -and
        $node.WorkflowId -ceq $context['CIRCLE_WORKFLOW_ID'] -and $node.JobNumber -ceq '302') 'each exact node selects only its fixed context, count and artifact namespace'
}
foreach ($spec in @(
    @{Key='CIRCLE_NODE_INDEX';Values=@('', '3', '-1', '00', '01', ' 0', '0 ', "0`n", 0, $null)},
    @{Key='CIRCLE_NODE_TOTAL';Values=@('', '1', '2', '4', '03', ' 3', '3 ', "3`n", 3, $null)},
    @{Key='CIRCLE_BUILD_NUM';Values=@('', '0', '-1', '0302', '3.02', ' 302', '302 ', "302`n", 302, $null)},
    @{Key='ZENTRA_NATIVE_PROFILE_PIPELINE_ID';Values=@('', 'aaaaaaaa-bbbb-cccc-dddd-EEEEEEEEEEEE', 'bad', "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`n", $null)},
    @{Key='CIRCLE_WORKFLOW_ID';Values=@('', 'bad', "11111111-2222-3333-4444-555555555555`n", $null)}
)) {
    foreach ($value in $spec.Values) {
        $copy = [ordered]@{}
        foreach ($key in $context.Keys) { $copy[$key] = $context[$key] }
        $copy[$spec.Key] = $value
        Assert-Refused { Assert-ZentraNativeProfileAdmission $copy } 'noncanonical or ambiguous node/pipeline/workflow/job identity refuses before side effects'
    }
}
$json = [IO.File]::ReadAllText((Join-Path $repo 'desktop/tests/fixtures/action-native-test-profile.public.json'))
$shaText = [IO.File]::ReadAllText((Join-Path $repo 'desktop/tests/fixtures/action-native-test-profile.public.sha256'))
$fixture = Get-ZentraNativeProfileFixture $json $shaText
Assert-Behavior ($fixture.Sha256.Length -eq 64 -and $fixture.Json -ceq $json) 'prepared public inputs preserve exact JSON and full SHA'
Assert-Behavior ((Get-ZentraNativeProfileFixture $json ("`n" + $shaText + "`n")).Sha256 -ceq $fixture.Sha256) 'only external LF can be trimmed'
foreach ($bad in @(($fixture.Sha256 + "`r`n"), (' ' + $fixture.Sha256), ($fixture.Sha256 + ' '),
    $fixture.Sha256.ToUpperInvariant(), ([char]0xfeff + $fixture.Sha256), $fixture.Sha256.Substring(0,63), ('0' * 64))) {
    Assert-Refused { Get-ZentraNativeProfileFixture $json $bad } 'nonexact or mismatched full manifest SHA refuses'
}

$bootstrapPlan = Get-ZentraNativeProfileRustupBootstrapPlan -ApplicationCount 0
Assert-Behavior $bootstrapPlan.Required 'an actually absent Rustup application requires the official bootstrap'
Assert-Behavior (-not (Get-ZentraNativeProfileRustupBootstrapPlan -ApplicationCount 1).Required) 'one present candidate never triggers repair'
Assert-Behavior (-not (Get-ZentraNativeProfileRustupBootstrapPlan -ApplicationCount 2).Required) 'multiple present candidates retain first-candidate validation without bootstrap'
Assert-Refused { Get-ZentraNativeProfileRustupBootstrapPlan -ApplicationCount -1 } 'negative candidate counts refuse'
Assert-Refused { Get-ZentraNativeProfileRustupBootstrapPlan -ApplicationCount 4097 } 'unbounded candidate counts refuse'
Assert-Behavior ($bootstrapPlan.InstallerUri -ceq 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' -and
    $bootstrapPlan.ChecksumUri -ceq 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe.sha256') 'only the exact historical official Rustup installer and checksum origins are allowed'
Assert-Behavior ($bootstrapPlan.RequestTimeoutSeconds -eq 120 -and $bootstrapPlan.MaximumRedirections -eq 0 -and
    $bootstrapPlan.MaximumInstallerBytes -eq 67108864 -and $bootstrapPlan.MaximumChecksumBytes -eq 1024 -and $bootstrapPlan.InstallerTimeoutSeconds -eq 1800) 'bootstrap downloads, sizes, redirects and installer time are bounded'
Assert-Behavior (($bootstrapPlan.InstallerArguments -join '|') -ceq '-y|--profile|minimal|--default-toolchain|stable-x86_64-pc-windows-msvc') 'bootstrap preserves the historical minimal MSVC installer arguments'
$installerSha = 'a' * 64
foreach ($document in @($installerSha, ($installerSha + "`n"), ($installerSha + "`r`n"), ($installerSha + '  rustup-init.exe'), ($installerSha + ' *rustup-init.exe'))) {
    Assert-Behavior ((Get-ZentraNativeProfileRustupChecksum $document) -ceq $installerSha) 'one exact official checksum document is accepted'
}
foreach ($document in @('', $installerSha.Substring(0,63), $installerSha.ToUpperInvariant(), (' ' + $installerSha),
    ([char]0xfeff + $installerSha), ($installerSha + '  other.exe'), ($installerSha + "`nextra"), ($installerSha + "`n" + $installerSha), ($installerSha + ' '))) {
    Assert-Refused { Get-ZentraNativeProfileRustupChecksum $document } 'malformed, ambiguous or foreign checksum documents refuse'
}
$null = Assert-ZentraNativeProfileRustupChecksum -Expected $installerSha -Actual $installerSha
Assert-Behavior $true 'matching exact installer bytes SHA is accepted'
Assert-Refused { Assert-ZentraNativeProfileRustupChecksum -Expected $installerSha -Actual ('b' * 64) } 'divergent installer bytes refuse'
Assert-Refused { Assert-ZentraNativeProfileRustupChecksum -Expected $installerSha -Actual $installerSha.ToUpperInvariant() } 'noncanonical actual installer hash refuses'
Assert-Refused { Assert-ZentraNativeProfileRustupChecksum -Expected 'invalid' -Actual $installerSha } 'noncanonical expected installer hash refuses'

# Corroborate the reviewed names against source declarations without compiling.
$profileNames = @()
foreach ($spec in @(
    @{File='native_test_profile.rs';Module='tests';Count=24},
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
Assert-Behavior ($plan.Filters.Count -eq 3 -and $plan.ProfileTestNames.Count -eq 32 -and $plan.ActionEngineTestNames.Count -eq 0) 'three exact modules select all 32 source names only'
foreach ($name in @(
    'sites_access_header_is_sensitive_and_preserves_device_authorization_and_body',
    'sites_access_rejects_invalid_tokens_without_retaining_them',
    'sites_access_installation_requires_a_valid_manifest_and_is_immutable',
    'sites_access_refuses_foreign_production_and_non_https_destinations',
    'sites_access_refuses_invalid_missing_profiles_and_preexisting_header',
    'sites_access_preserves_site_paths_and_ordinary_tests_without_a_token'
)) {
    $fullName = 'native_test_profile::tests::' + $name
    Assert-Behavior ($plan.ProfileTestNames -ccontains $fullName) 'each reviewed Sites header source regression is selected'
    Assert-Refused { Get-ZentraNativeProfileVerificationPlan @($catalogue | Where-Object { $_ -cne $fullName }) } 'missing Sites header regression refuses'
}
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
Assert-Behavior ($result.TotalPassed -eq 32 -and $result.ProfilePassed -eq 32 -and $result.RuntimeNamesAndCountsCorroborated) 'synthetic successful raw logs corroborate all exact names'
foreach ($case in @(
    @{Name='nonzero exit';Change={param($e) $e.Executions[0].exit=1}},
    @{Name='failed test';Change={param($e) $e.Executions[0].failed=1}},
    @{Name='ignored test';Change={param($e) $e.Executions[0].ignored=1}},
    @{Name='missing pass';Change={param($e) $e.Executions[0].passed--}},
    @{Name='string counter';Change={param($e) $e.Executions[0].passed='24'}},
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
Assert-Behavior ($absentPlan.Filters.Count -eq 36 -and $absentPlan.ExpectedTotal -eq 271 -and $absentResult.ActionEnginePassed -eq 239) 'absent context adds unchanged 33-suite 239 selection to the three profile modules'
Assert-Behavior ($absentResult.TotalPassed -eq 271 -and $result.TotalPassed -eq 32) 'each synthetic result attests only its own fixed count; no local aggregate is produced'

$transportFiles = @(
    [pscustomobject]@{path='native-profile-verification-proof.json';bytes=12},
    [pscustomobject]@{path='windows-test-suite-01-errors.log';bytes=0},
    [pscustomobject]@{path='nested/details.txt';bytes=4}
)
$transportPlan = Get-ZentraNativeProfileTransportPlan -Context $context -Files $transportFiles
Assert-Behavior ($transportPlan.TotalBytes -eq 16 -and $transportPlan.Paths.Count -eq 3 -and
    $transportPlan.Paths[0] -ceq 'native-profile-verification-proof.json' -and
    $transportPlan.ZipName -ceq 'node-0-absent-evidence.zip' -and
    $transportPlan.ReceiptName -ceq 'node-0-absent-evidence.receipt.json') 'transport plan includes empty files in an ordinal inventory with output outside the node'
foreach ($path in @('', '.', '..', '../escape', '/absolute', 'C:/drive', 'a\b', 'a//b', 'a/./b',
    'a/../b', 'a.', 'a/b.', 'a/CON.log', 'nul', 'COM1', 'LPT9.txt', 'space name', "tab`tname", ('a' * 241))) {
    Assert-Refused { Assert-ZentraNativeProfileTransportRelativePath -Path $path } 'transport refuses escapes, aliases, ambiguous names and unbounded relative paths'
}
foreach ($files in @(
    @(),
    @([pscustomobject]@{path='other.log';bytes=0}),
    @([pscustomobject]@{path='NATIVE-profile-verification-proof.json';bytes=0}),
    @($transportFiles + [pscustomobject]@{path='NESTED/DETAILS.TXT';bytes=1}),
    @($transportFiles + [pscustomobject]@{path='nested';bytes=1}),
    @($transportFiles + [pscustomobject]@{path='negative.log';bytes=-1}),
    @($transportFiles + [pscustomobject]@{path='string.log';bytes='1'}),
    @($transportFiles + [pscustomobject]@{path='fraction.log';bytes=1.5}),
    @($transportFiles + [pscustomobject]@{path='large.log';bytes=134217729}),
    @($transportFiles + [pscustomobject]@{path='large1.log';bytes=134217728} + [pscustomobject]@{path='large2.log';bytes=134217728})
)) {
    Assert-Refused { Get-ZentraNativeProfileTransportPlan -Context $context -Files $files } 'transport refuses incomplete, colliding or unbounded inventories'
}
$manyFiles = @($transportFiles)
for ($i=0; $i -lt 510; $i++) { $manyFiles += [pscustomobject]@{path="file-$i.log";bytes=0} }
Assert-Refused { Get-ZentraNativeProfileTransportPlan -Context $context -Files $manyFiles } 'transport refuses more than 512 files before reading contents'
$limitPlan = Get-ZentraNativeProfileTransportPlan -Context $context -Files @(
    [pscustomobject]@{path='native-profile-verification-proof.json';bytes=0},
    [pscustomobject]@{path='one.log';bytes=134217728},
    [pscustomobject]@{path='two.log';bytes=134217728}
)
Assert-Behavior ($limitPlan.TotalBytes -eq 268435456) 'exact per-file and complete byte limits are accepted by the pure plan without creating large files'

# Exercise only managed file/ZIP APIs on small text fixtures. No runner or harness.
$temporaryRoot = [IO.Path]::Combine([IO.Path]::GetTempPath(),('zentra-profile-transport-test-' + [Guid]::NewGuid().ToString('N')))
$cleanupRoot = [IO.Path]::GetFullPath($temporaryRoot)
try {
    $null = [IO.Directory]::CreateDirectory($temporaryRoot)
    $nodePath = Join-Path $temporaryRoot 'node-0-absent'
    $null = [IO.Directory]::CreateDirectory((Join-Path $nodePath 'nested'))
    [IO.File]::WriteAllText((Join-Path $nodePath 'native-profile-verification-proof.json'),'synthetic proof only',[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $nodePath 'nested/details.txt'),"synthetic text`n",[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllBytes((Join-Path $nodePath 'windows-test-suite-01-errors.log'),[byte[]]@())
    $transportContext = [ordered]@{}
    foreach ($key in $context.Keys) { $transportContext[$key] = $context[$key] }
    $sourceLines = @(& git -C $repo rev-parse HEAD)
    if ($LASTEXITCODE -ne 0 -or $sourceLines.Count -ne 1) { throw 'Synthetic transport test needs the existing repository HEAD.' }
    $transportContext['CIRCLE_SHA1'] = $sourceLines[0]
    $wrongSource = [ordered]@{}
    foreach ($key in $transportContext.Keys) { $wrongSource[$key] = $transportContext[$key] }
    $wrongSource['CIRCLE_SHA1'] = '0' * 40
    Assert-Refused { Write-ZentraNativeProfileTransportBundle -Context $wrongSource -Repository $repo -ArtifactRoot $temporaryRoot } 'transport refuses a different source before creating output'
    Assert-Behavior (@(Get-ChildItem -LiteralPath $temporaryRoot -File -Force).Count -eq 0) 'source refusal creates no bundle or receipt'
    $wrongAdmission = [ordered]@{}
    foreach ($key in $transportContext.Keys) { $wrongAdmission[$key] = $transportContext[$key] }
    $wrongAdmission['CIRCLE_BRANCH'] = 'main'
    Assert-Refused { Write-ZentraNativeProfileTransportBundle -Context $wrongAdmission -Repository $repo -ArtifactRoot (Join-Path $temporaryRoot 'does-not-exist') } 'transport admission refuses before any artifact path lookup or creation'
    $hardLink = Join-Path $nodePath 'linked.log'
    $null = New-Item -ItemType HardLink -Path $hardLink -Target (Join-Path $nodePath 'nested/details.txt')
    Assert-Refused { Write-ZentraNativeProfileTransportBundle -Context $transportContext -Repository $repo -ArtifactRoot $temporaryRoot } 'transport refuses real hard-linked files before reading evidence'
    Remove-Item -LiteralPath $hardLink -Force
    $junction = Join-Path $temporaryRoot 'linked-node'
    $null = New-Item -ItemType Junction -Path $junction -Target $nodePath
    Assert-Refused { Get-ZentraNativeProfileTransportInventory -NodePath (Join-Path $junction 'nested') } 'transport refuses a real linked ancestor'
    Remove-Item -LiteralPath $junction -Force
    Assert-Behavior (@(Get-ChildItem -LiteralPath $temporaryRoot -File -Force).Count -eq 0) 'link refusal creates no bundle or receipt'
    $bundle = Write-ZentraNativeProfileTransportBundle -Context $transportContext -Repository $repo -ArtifactRoot $temporaryRoot
    $receipt = [IO.File]::ReadAllText($bundle.ReceiptPath) | ConvertFrom-Json
    Assert-Behavior ($receipt.kind -ceq 'isolated-native-test-profile-transport-receipt' -and $receipt.schemaVersion -eq 1 -and
        $receipt.source -ceq $transportContext['CIRCLE_SHA1'] -and $receipt.circleSource -ceq $receipt.source -and
        $receipt.pipelineId -ceq $context['ZENTRA_NATIVE_PROFILE_PIPELINE_ID'] -and $receipt.workflowId -ceq $context['CIRCLE_WORKFLOW_ID'] -and
        $receipt.jobNumber -ceq '302' -and $receipt.nodeIndex -eq 0 -and $receipt.nodeTotal -eq 3 -and $receipt.context -ceq 'absent') 'synthetic transport receipt retains exact source and node identities without a runtime result'
    Assert-Behavior ($receipt.fileCount -eq 3 -and $receipt.files.Count -eq 3 -and
        $receipt.nodeDirectory -ceq 'node-0-absent' -and $receipt.finalProofPath -ceq 'native-profile-verification-proof.json' -and
        $receipt.zip.path -ceq 'node-0-absent-evidence.zip' -and $receipt.zip.bytes -eq (Get-Item -LiteralPath $bundle.ZipPath).Length -and
        $receipt.zip.sha256 -ceq (Get-FileHash -LiteralPath $bundle.ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()) 'receipt hash and size corroborate the actual fresh managed ZIP'
    $zipStream = [IO.File]::OpenRead($bundle.ZipPath)
    $zip = [IO.Compression.ZipArchive]::new($zipStream,[IO.Compression.ZipArchiveMode]::Read,$false)
    try {
        Assert-Behavior ($zip.Entries.Count -eq 3 -and @($zip.Entries | Where-Object {$_.FullName -like '*evidence*'}).Count -eq 0) 'ZIP includes all actual node files and never its own ZIP or receipt'
        $sum = [long]0
        foreach ($file in $receipt.files) {
            $entry = $zip.GetEntry($file.path)
            $entryStream = $entry.Open()
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $actualSha = [BitConverter]::ToString($sha.ComputeHash($entryStream)).Replace('-','').ToLowerInvariant() }
            finally { $sha.Dispose(); $entryStream.Dispose() }
            Assert-Behavior ($entry.Length -eq $file.bytes -and $actualSha -ceq $file.sha256 -and
                $file.sha256 -ceq (Get-FileHash -LiteralPath (Join-Path $nodePath $file.path) -Algorithm SHA256).Hash.ToLowerInvariant()) 'each receipt row corroborates source bytes and real decompressed ZIP bytes'
            $sum += $file.bytes
        }
        Assert-Behavior ($sum -eq $receipt.totalBytes -and $zip.GetEntry('windows-test-suite-01-errors.log').Length -eq 0 -and
            @($receipt.files | Where-Object {$_.path -ceq 'windows-test-suite-01-errors.log'})[0].sha256 -ceq 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') 'a real zero-byte stderr remains an explicit zero-byte ZIP entry with its SHA-256'
    } finally { $zip.Dispose(); $zipStream.Dispose() }
    $originalZipHash = (Get-FileHash -LiteralPath $bundle.ZipPath -Algorithm SHA256).Hash
    $originalReceiptHash = (Get-FileHash -LiteralPath $bundle.ReceiptPath -Algorithm SHA256).Hash
    Assert-Refused { Write-ZentraNativeProfileTransportBundle -Context $transportContext -Repository $repo -ArtifactRoot $temporaryRoot } 'transport never overwrites an existing ZIP or receipt'
    Assert-Behavior ((Get-FileHash -LiteralPath $bundle.ZipPath -Algorithm SHA256).Hash -ceq $originalZipHash -and
        (Get-FileHash -LiteralPath $bundle.ReceiptPath -Algorithm SHA256).Hash -ceq $originalReceiptHash) 'fresh-output refusal preserves both original transport hashes'
    Assert-Behavior (@($receipt.PSObject.Properties.Name | Where-Object {$_ -cin @('passed','runtimePassed','contextPassed','expectedTotal','allContextsPassed','aggregationExecuted')}).Count -eq 0) 'transport receipt cannot introduce a native or aggregate success result'
    Remove-Item -LiteralPath $bundle.ZipPath -Force
    Assert-Refused { Write-ZentraNativeProfileTransportBundle -Context $transportContext -Repository $repo -ArtifactRoot $temporaryRoot } 'an existing receipt alone also refuses before creating a replacement ZIP'
    Assert-Behavior (-not (Test-Path -LiteralPath $bundle.ZipPath) -and
        (Get-FileHash -LiteralPath $bundle.ReceiptPath -Algorithm SHA256).Hash -ceq $originalReceiptHash) 'receipt-only refusal preserves existing evidence and creates no ZIP'
} finally {
    if ([IO.Path]::GetFullPath($temporaryRoot) -cne $cleanupRoot -or
        -not $cleanupRoot.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($cleanupRoot) -cnotmatch '\Azentra-profile-transport-test-[0-9a-f]{32}\z') { throw 'Refusing synthetic fixture cleanup outside its checked temporary directory.' }
    if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}

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
    ($n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -cin @('Invoke-WebRequest','Invoke-ZentraHarnessTool','Initialize-ZentraVerificationHarness','Invoke-ZentraVerificationSuite','Save-ZentraHarnessProof'))
},$true))
Assert-Behavior ($mutations.Count -gt 0 -and @($mutations | Where-Object {$_.Extent.StartOffset -lt $guard[0].Extent.EndOffset}).Count -eq 0) 'admission precedes every environment mutation, directory, bootstrap and harness action'
$runnerText = [IO.File]::ReadAllText($runnerPath)
$headGuard = @($runnerAst.FindAll({param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.Contains('HEAD to equal the exact CircleCI source')},$true))
Assert-Behavior ($headGuard.Count -eq 1 -and @($mutations | Where-Object {$_.Extent.StartOffset -lt $headGuard[0].Extent.EndOffset}).Count -eq 0) 'source equality refuses before mutation and bootstrap'
Assert-Behavior (@($calls | Where-Object {$_.GetCommandName() -cin @('cargo','Start-Process','cloud-release-windows.ps1','npm','npm.cmd','pnpm','pnpm.cmd')}).Count -eq 0) 'runner has no direct Cargo, process, release or frontend invocation'
$bootstrapBranches = @($runnerAst.FindAll({param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Clauses[0].Item1.Extent.Text -ceq '$bootstrapPlan.Required'},$true))
Assert-Behavior ($bootstrapBranches.Count -eq 1 -and $bootstrapBranches[0].ElseClause -eq $null) 'only the pure absent-candidate plan permits a bootstrap branch'
$bootstrapBranch = $bootstrapBranches[0]
$downloads = @($calls | Where-Object {$_.GetCommandName() -ceq 'Invoke-WebRequest'})
Assert-Behavior ($downloads.Count -eq 2 -and @($downloads | Where-Object {$_.Extent.StartOffset -lt $bootstrapBranch.Clauses[0].Item2.Extent.StartOffset -or $_.Extent.EndOffset -gt $bootstrapBranch.Clauses[0].Item2.Extent.EndOffset}).Count -eq 0) 'both and only vendor downloads occur inside the absent Rustup branch'
foreach ($spec in @(
    @{Index=0;Text=@'
Invoke-WebRequest -UseBasicParsing -Uri $bootstrapPlan.InstallerUri -OutFile $installer `
                -TimeoutSec $bootstrapPlan.RequestTimeoutSeconds -MaximumRedirection $bootstrapPlan.MaximumRedirections
'@},
    @{Index=1;Text=@'
Invoke-WebRequest -UseBasicParsing -Uri $bootstrapPlan.ChecksumUri -OutFile $checksumPath `
                -TimeoutSec $bootstrapPlan.RequestTimeoutSeconds -MaximumRedirection $bootstrapPlan.MaximumRedirections
'@}
)) {
    # Match the exact closed call shape, including both bounds and no redirect,
    # provider endpoint, runtime URL or fallback parameter.
    $actualDownload = $downloads[$spec.Index].Extent.Text.Replace("`r`n","`n")
    Assert-Behavior ($actualDownload -ceq $spec.Text.Replace("`r`n","`n")) 'vendor download calls have exact planned URL, fixed artifact and limits'
}
$checksumAssertions = @($calls | Where-Object {$_.GetCommandName() -ceq 'Assert-ZentraNativeProfileRustupChecksum'})
$installerCalls = @($calls | Where-Object {$_.GetCommandName() -ceq 'Invoke-ZentraHarnessTool' -and $_.CommandElements[1].Extent.Text -ceq '$installer'})
Assert-Behavior ($checksumAssertions.Count -eq 1 -and $installerCalls.Count -eq 1 -and
    $checksumAssertions[0].Extent.EndOffset -lt $installerCalls[0].Extent.StartOffset -and
    $installerCalls[0].Extent.StartOffset -gt $bootstrapBranch.Clauses[0].Item2.Extent.StartOffset -and
    $installerCalls[0].Extent.EndOffset -lt $bootstrapBranch.Clauses[0].Item2.Extent.EndOffset) 'exact checksum equality is asserted before the sole bounded installer execution'
Assert-Behavior ($installerCalls[0].Extent.Text.Contains('-TimeoutSeconds $bootstrapPlan.InstallerTimeoutSeconds') -and
    $installerCalls[0].Extent.Text.Contains("'rustup-install.log'") -and $installerCalls[0].Extent.Text.Contains("'rustup-install-errors.log'")) 'installer execution uses harness timeout and distinct raw logs'
$candidateAssignments = @($runnerAst.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$rustupCandidates'},$true))
Assert-Behavior ($candidateAssignments.Count -eq 2 -and $candidateAssignments[1].Extent.StartOffset -gt $installerCalls[0].Extent.EndOffset -and
    $candidateAssignments[1].Extent.EndOffset -lt $bootstrapBranch.Clauses[0].Item2.Extent.EndOffset) 'successful installation is followed by fresh PATH resolution rather than fabricated metadata'
Assert-Behavior ($runnerText.Contains('if ($bootstrapProof.installerExit -ne 0) { throw') -and
    $runnerText.Contains('$rustup = Select-ZentraHarnessApplication $rustupCandidates') -and
    $runnerText.Contains("[IO.Path]::GetFileName(`$rustup) -cne 'rustup.exe'")) 'installer failure and invalid installed resolver refuse before toolchain compilation'
Assert-Behavior ($runnerText.Contains('$bootstrapProof.installerBytes -gt $bootstrapPlan.MaximumInstallerBytes') -and
    $runnerText.Contains('$bootstrapProof.checksumBytes -gt $bootstrapPlan.MaximumChecksumBytes')) 'both raw download sizes are checked before installation'
$bootstrapTry = @($runnerAst.FindAll({param($n) $n -is [Management.Automation.Language.TryStatementAst] -and $null -ne $n.Finally -and $n.Finally.Extent.Text.Contains("'native-profile-bootstrap-proof.json'")},$true))
Assert-Behavior ($bootstrapTry.Count -eq 1 -and $bootstrapTry[0].Finally.Extent.Text.Contains('$proof.bootstrap = $bootstrapProof')) 'bootstrap raw hashes, state and result are saved independently even on refusal'
Assert-Behavior ($runnerText.Contains('$context = $node.Context') -and
    -not $runnerText.Contains("foreach (`$context in @('absent','sandbox','partial'))") -and
    $runnerText.Contains('-IncludeActionEngine:($context -ceq ''absent'')')) 'one admitted node selects one compiled context, with legacy tests only in absent'
$nodePlanCalls = @($calls | Where-Object {$_.GetCommandName() -ceq 'Get-ZentraNativeProfileNodePlan'})
$fixtureReads = @($runnerAst.FindAll({param($n) $n -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Member.Value -ceq 'ReadAllBytes'},$true))
Assert-Behavior ($nodePlanCalls.Count -eq 1 -and $nodePlanCalls[0].Extent.StartOffset -gt $guard[0].Extent.EndOffset -and
    @($fixtureReads | Where-Object {$_.Extent.StartOffset -lt $headGuard[0].Extent.EndOffset}).Count -eq 0 -and
    @($fixtureReads | Where-Object {$_.Extent.StartOffset -lt $nodePlanCalls[0].Extent.EndOffset}).Count -eq 0) 'node identity and exact source admission precede original fixture byte reads'
Assert-Behavior ($runnerText.Contains("kind='isolated-native-test-profile-node-verification'") -and
    $runnerText.Contains('nodeIndex=$node.NodeIndex; nodeTotal=$node.NodeTotal; context=$context') -and
    $runnerText.Contains('pipelineId=$node.PipelineId; workflowId=$node.WorkflowId; jobNumber=$node.JobNumber') -and
    $runnerText.Contains('$node.ArtifactDirectory') -and $runnerText.Contains('NATIVE_PROFILE_NODE source=') -and
    $runnerText.Contains('NATIVE_PROFILE_NODE_PASSED job=')) 'proof, artifact namespace and public logs identify the real source/pipeline/workflow/job/node/context'
Assert-Behavior ($runnerText.Contains('expectedTotal=$node.ExpectedTotal') -and $runnerText.Contains('aggregationExecuted=$false') -and
    $runnerText.Contains('if ($plan.ExpectedTotal -ne $node.ExpectedTotal)') -and
    $runnerText.Contains('$proof.runtimePassed = $corroboration.TotalPassed') -and
    -not $runnerText.Contains('317') -and -not $runnerText.Contains('335') -and -not $runnerText.Contains('allContextsPassed') -and
    -not $runnerText.Contains('$proof.runtimePassed +=')) 'a node cannot claim the aggregate total or other contexts passing'
Assert-Behavior ($runnerText.Contains('$contextProof.profileTestNames = $plan.ProfileTestNames') -and
    $runnerText.Contains('$contextProof.catalogueCount = $plan.CatalogueCount') -and
    $runnerText.Contains("'native-profile-context-proof.json'")) 'each node retains its compiled profile catalogue and independent corroborated context proof for later offline comparison'
Assert-Behavior ($runnerText.Contains('$proof.toolchain.exit = $toolchainExit') -and
    $runnerText.Contains('$proof.toolchain.prepared = $true') -and
    $runnerText.Contains("stdout='toolchain-install.log';stderr='toolchain-install-errors.log'")) 'each node retains its real independent toolchain setup result and fixed raw logs'
$topTry = @($runnerAst.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})
Assert-Behavior ($topTry.Count -eq 1 -and $null -ne $topTry[0].Finally -and $topTry[0].Finally.Extent.Text.Contains('[Environment]::SetEnvironmentVariable($name,$savedEnvironment[$name],''Process'')')) 'process environment is restored in the outer finally'
Assert-Behavior ($runnerText.Contains('ZENTRA_ACTION_FULL_ARCHIVE_EVIDENCE') -and $runnerText.Contains('fullArchiveInteropExecuted=$false') -and $runnerText.Contains('historicalG0EvidenceModified=$false')) 'new archive export and proof never claim a new ZIP-to-TS execution or rewrite G0'
Assert-Behavior ($runnerText.Contains('[Text.UTF8Encoding]::new($false,$true)') -and $runnerText.Contains('$strictUtf8.GetString([IO.File]::ReadAllBytes($fixtureShaPath))')) 'fixture SHA is decoded from strict original UTF8 bytes without automatic BOM removal'
$transportCalls = @($calls | Where-Object {$_.GetCommandName() -ceq 'Write-ZentraNativeProfileTransportBundle'})
$finalProofCalls = @($calls | Where-Object {$_.GetCommandName() -ceq 'Save-ZentraHarnessProof' -and $_.Extent.Text.Contains("'native-profile-verification-proof.json'")})
Assert-Behavior ($transportCalls.Count -eq 1 -and $finalProofCalls.Count -eq 1 -and
    $finalProofCalls[0].Extent.EndOffset -lt $transportCalls[0].Extent.StartOffset -and
    $transportCalls[0].Extent.StartOffset -gt $topTry[0].Finally.Extent.StartOffset -and
    $transportCalls[0].Extent.EndOffset -lt $topTry[0].Finally.Extent.EndOffset -and
    $transportCalls[0].Extent.Text -ceq 'Write-ZentraNativeProfileTransportBundle -Context $admission -Repository $repo -ArtifactRoot $artifactRoot') 'sole transport call follows final proof saving and environment restoration inside outer finally'
$helperTokens=$null; $helperErrors=$null
$helperAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'action-native-profile-verification.ps1'),[ref]$helperTokens,[ref]$helperErrors)
Assert-Behavior ($helperErrors.Count -eq 0) 'managed transport helper AST parses'
$writer = @($helperAst.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Write-ZentraNativeProfileTransportBundle'},$true))[0]
$writerText = $writer.Extent.Text
Assert-Behavior ($writerText.Contains('[IO.Compression.ZipArchive]::new') -and $writerText.Contains('[IO.FileMode]::CreateNew') -and
    $writerText.Contains('[IO.FileShare]::Read)') -and $writerText.Contains('Get-ZentraNativeProfileTransportInventory') -and
    -not $writerText.Contains('Compress-Archive') -and -not $writerText.Contains('Save-ZentraHarnessProof')) 'transport uses only managed ZIP and exclusive fresh outputs without rewriting any proof'
$writerCommands = @($writer.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst]},$true))
Assert-Behavior (@($writerCommands | Where-Object {$_.GetCommandName() -cin @('Invoke-WebRequest','Start-Process','Invoke-ZentraHarnessTool','Initialize-ZentraVerificationHarness','Invoke-ZentraVerificationSuite','cargo','rustup','7z','tar')}).Count -eq 0) 'managed transport cannot invoke network, app packaging or native tools'
$writerAdmission = @($writerCommands | Where-Object {$_.GetCommandName() -ceq 'Assert-ZentraNativeProfileAdmission'})
$writerSource = @($writerCommands | Where-Object {$_.GetCommandName() -ceq 'Assert-ZentraNativeProfileTransportSource'})
$writerInventories = @($writerCommands | Where-Object {$_.GetCommandName() -ceq 'Get-ZentraNativeProfileTransportInventory'})
$opens = @($writer.FindAll({param($n) $n -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $n.Expression.Extent.Text -ceq '[IO.FileStream]'},$true))
Assert-Behavior ($writerAdmission.Count -eq 1 -and $writerSource.Count -eq 2 -and $writerInventories.Count -eq 2 -and $opens.Count -eq 3 -and
    $writerAdmission[0].Extent.EndOffset -lt $writerSource[0].Extent.StartOffset -and
    $writerSource[0].Extent.EndOffset -lt $writerInventories[0].Extent.StartOffset -and
    $writerInventories[0].Extent.EndOffset -lt $opens[0].Extent.StartOffset -and
    $writerInventories[1].Extent.EndOffset -lt $writerSource[1].Extent.StartOffset -and
    $writerSource[1].Extent.EndOffset -lt $opens[2].Extent.StartOffset) 'transport revalidates admission/source and the complete metadata inventory before reads and again before a receipt'
Write-Host "Native profile CI pure behavior/AST/managed-ZIP checks passed: $script:passed (nativeExecution=false; CI runner never executed)."
