# Pure CI admission, selection and result checks. Dot-sourcing never runs tools,
# opens a store, changes environment variables or executes a native harness.
Set-StrictMode -Version Latest

function Assert-ZentraNativeProfileAdmission {
    param([Parameter(Mandatory=$true)][Collections.IDictionary]$Context)
    $required = [ordered]@{
        CIRCLECI='true'; OS='Windows_NT'; CIRCLE_BRANCH='codex/action-engine-native'
        ZENTRA_VERIFY_DIAGNOSTICS_ONLY='true'; ZENTRA_VERIFY_ONLY='true'
        ZENTRA_VERIFY_NATIVE_PROFILE_ONLY='true'; ZENTRA_NATIVE_PROFILE_RELEASE='false'
        ZENTRA_DIAGNOSTICS_NATIVE_SET='action-engine'
        RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-msvc'
    }
    foreach ($name in $required.Keys) {
        if (-not $Context.Contains($name) -or $Context[$name] -cne $required[$name]) {
            throw 'Native profile verification requires the exact isolated Windows CI admission.'
        }
    }
    if (-not $Context.Contains('CIRCLE_SHA1') -or $Context['CIRCLE_SHA1'] -cnotmatch '^[0-9a-f]{40}$' -or
        -not $Context.Contains('CARGO_TARGET_DIR') -or -not [string]::IsNullOrEmpty($Context['CARGO_TARGET_DIR'])) {
        throw 'Native profile verification requires an exact source and the standard harness target directory.'
    }
    $null = Get-ZentraNativeProfileNodePlan -Context $Context
}

function Get-ZentraNativeProfileNodePlan {
    param([Parameter(Mandatory=$true)][Collections.IDictionary]$Context)
    if (-not $Context.Contains('CIRCLE_NODE_TOTAL') -or $Context['CIRCLE_NODE_TOTAL'] -isnot [string] -or $Context['CIRCLE_NODE_TOTAL'] -cne '3' -or
        -not $Context.Contains('CIRCLE_NODE_INDEX') -or $Context['CIRCLE_NODE_INDEX'] -isnot [string] -or
        $Context['CIRCLE_NODE_INDEX'] -cnotmatch '\A[012]\z') {
        throw 'Native profile verification requires one exact node of the three-node context mapping.'
    }
    foreach ($name in @('ZENTRA_NATIVE_PROFILE_PIPELINE_ID','CIRCLE_WORKFLOW_ID')) {
        if (-not $Context.Contains($name) -or $Context[$name] -isnot [string] -or
            $Context[$name] -cnotmatch '\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z') {
            throw 'Native profile verification requires exact pipeline and workflow identities.'
        }
    }
    if (-not $Context.Contains('CIRCLE_BUILD_NUM') -or $Context['CIRCLE_BUILD_NUM'] -isnot [string] -or
        $Context['CIRCLE_BUILD_NUM'] -cnotmatch '\A[1-9][0-9]{0,9}\z') {
        throw 'Native profile verification requires an exact CI job number.'
    }
    $index = [int]$Context['CIRCLE_NODE_INDEX']
    $name = @('absent','sandbox','partial')[$index]
    return [pscustomobject]@{
        NodeIndex=$index; NodeTotal=3; Context=$name
        ExpectedTotal=$(if ($index -eq 0) {265} else {26})
        ArtifactDirectory=('node-{0}-{1}' -f $index,$name)
        PipelineId=$Context['ZENTRA_NATIVE_PROFILE_PIPELINE_ID']
        WorkflowId=$Context['CIRCLE_WORKFLOW_ID']; JobNumber=$Context['CIRCLE_BUILD_NUM']
    }
}

function Get-ZentraNativeProfileFixture {
    param([Parameter(Mandatory=$true)][string]$Json, [Parameter(Mandatory=$true)][string]$Sha256Text)
    # Only external LF is removed. CR, spaces, BOM and mixed-case hashes refuse.
    $sha256 = $Sha256Text.Trim([char[]]@([char]10))
    if ($sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'The public fixture SHA must be exactly 64 lowercase hex characters plus optional external LF.' }
    $envelope = $Json | ConvertFrom-Json
    if ($envelope.format -cne 'zentra-action-native-test-profile' -or $envelope.schemaVersion -ne 1 -or
        $envelope.deploymentProfileSha256 -cne $sha256 -or $envelope.profile.kind -cne 'sandbox') {
        throw 'The prepared public sandbox fixture and complete manifest SHA do not agree.'
    }
    return [pscustomobject]@{
        Json=$Json; Sha256=$sha256
        ExpectedPublicValues=[ordered]@{
            siteOrigin=$envelope.profile.siteOrigin; supabaseOrigin=$envelope.profile.supabaseOrigin
            licenseKid=$envelope.profile.license.kid; licensePublicKeyB64url=$envelope.profile.license.publicKeyB64url
            deploymentProfileSha256=$sha256
        }
    }
}

function Get-ZentraNativeProfileRustupBootstrapPlan {
    param([Parameter(Mandatory=$true)][ValidateRange(0,4096)][int]$ApplicationCount)
    # A present but invalid candidate is refused by the existing harness;
    # only an actually absent vendor resolver permits installation.
    return [pscustomobject]@{
        Required=($ApplicationCount -eq 0)
        InstallerUri='https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe'
        ChecksumUri='https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe.sha256'
        RequestTimeoutSeconds=120; MaximumRedirections=0
        MaximumInstallerBytes=67108864; MaximumChecksumBytes=1024
        InstallerTimeoutSeconds=1800
        InstallerArguments=[string[]]@('-y','--profile','minimal','--default-toolchain','stable-x86_64-pc-windows-msvc')
    }
}

function Get-ZentraNativeProfileRustupChecksum {
    param([Parameter(Mandatory=$true)][AllowEmptyString()][string]$Text)
    $document = $Text.Trim([char[]]@([char]10,[char]13))
    $match = [regex]::Match($document, '\A([0-9a-f]{64})(?:[ \t]+\*?rustup-init\.exe)?\z')
    if (-not $match.Success) { throw 'The official Rustup checksum must contain one exact lowercase SHA-256 for rustup-init.exe.' }
    return $match.Groups[1].Value
}

function Assert-ZentraNativeProfileRustupChecksum {
    param([Parameter(Mandatory=$true)][string]$Expected, [Parameter(Mandatory=$true)][string]$Actual)
    if ($Expected -cnotmatch '^[0-9a-f]{64}$' -or $Actual -cnotmatch '^[0-9a-f]{64}$' -or $Expected -cne $Actual) {
        throw 'The official Rustup installer checksum does not match.'
    }
}

function Get-ZentraNativeProfileVerificationPlan {
    param([Parameter(Mandatory=$true)][AllowEmptyCollection()][string[]]$TestNames, [switch]$IncludeActionEngine)
    $catalogue = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $TestNames) {
        if ($name -cnotmatch '^[A-Za-z_][A-Za-z0-9_:]*$' -or -not $catalogue.Add($name)) {
            throw 'The native profile catalogue contains an invalid or duplicate name.'
        }
    }
    # Exact reviewed names prevent a same-count replacement from passing.
    $modules = [ordered]@{
        'native_test_profile::tests::'=@(
            'actual_server_preparer_fixture_and_complete_hash_are_accepted'
            'absent_compilation_inputs_are_unconfigured_and_partial_inputs_refuse'
            'profile_hash_is_independent_of_recursive_object_order_and_whitespace'
            'utf8_and_exact_8192_byte_limit_are_enforced_without_truncation'
            'expected_and_embedded_hashes_are_separate_exact_lowercase_full_values'
            'complete_manifest_is_closed_and_requires_every_field_at_every_level'
            'all_four_wire_structures_refuse_coherent_positional_arrays'
            'duplicate_and_escaped_equivalent_fields_refuse_from_original_bytes'
            'every_production_host_is_refused_in_both_origin_positions_with_coherent_hash'
            'origins_require_canonical_https_hosts_without_aliases_or_url_components'
            'site_and_supabase_origins_must_be_distinct'
            'supabase_requires_exactly_twenty_lowercase_ascii_reference_letters'
            'production_key_and_kid_are_refused_with_coherent_hashes'
            'license_key_requires_exact_canonical_unpadded_32_byte_base64url'
            'sandbox_identifiers_names_updater_and_kind_are_exact'
            'sandbox_profile_id_and_kid_grammar_and_bounds_match_the_preparer'
            'schema_versions_match_numeric_one_and_discriminators_are_literal'
            'malformed_json_and_wrong_types_return_only_the_fixed_redacted_error'
        )
        'account_cloud::sandbox_profile_tests::'=@(
            'compiled_origin_is_shared_by_real_account_routes_and_portal'
            'sandbox_approval_refuses_raw_url_normalization_and_foreign_origin'
            'compiled_approval_preserves_production_compatibility_only_when_unconfigured'
            'live_qa_admission_requires_the_complete_profile_without_opening_a_store_or_transport'
        )
        'license::sandbox_profile_tests::'=@(
            'compiled_license_authority_is_one_key_and_kid_or_a_closed_error'
            'compiled_sandbox_key_cannot_be_replaced_by_the_ordinary_mutable_fixture'
            'real_refresh_url_uses_the_same_compiled_origin_without_transport_or_store'
            'real_signature_verifier_distinguishes_wrong_kid_from_wrong_key'
        )
    }
    $filters = @()
    $selected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($prefix in $modules.Keys) {
        $expected = [string[]]@($modules[$prefix] | ForEach-Object { $prefix + $_ })
        $actual = @($TestNames | Where-Object { $_.Contains($prefix) })
        if ($actual.Count -ne $expected.Count) { throw 'The reviewed native profile module count changed.' }
        foreach ($name in $actual) {
            if ($name -cnotin $expected -or -not $selected.Add($name)) { throw 'The native profile catalogue contains an unreviewed or overlapping test.' }
        }
        $filters += [pscustomobject]@{Name=$prefix;Arguments=[string[]]@();ExpectedCount=$expected.Count;TestNames=$expected;Group='profile'}
    }
    $profileNames = [string[]]@($selected)
    $actionNames = [string[]]@()
    if ($IncludeActionEngine) {
        . (Join-Path $PSScriptRoot 'action-engine-verification.ps1')
        $actionPlan = Get-ZentraActionEngineVerificationPlan -TestNames $TestNames
        $actionNames = [string[]]$actionPlan.SelectedTestNames
        foreach ($filter in $actionPlan.Filters) {
            $names = [string[]]@($TestNames | Where-Object {
                if ($filter.Arguments -ccontains '--exact') { $_ -ceq $filter.Name } else { $_.Contains($filter.Name) }
            })
            foreach ($name in $names) { if (-not $selected.Add($name)) { throw 'Profile and Action Engine selections overlap.' } }
            $filters += [pscustomobject]@{Name=$filter.Name;Arguments=$filter.Arguments;ExpectedCount=$filter.ExpectedCount;TestNames=$names;Group='action-engine'}
        }
    }
    $allNames = [string[]]@($selected)
    [Array]::Sort($profileNames, [StringComparer]::Ordinal)
    [Array]::Sort($allNames, [StringComparer]::Ordinal)
    return [pscustomobject]@{
        Filters=$filters; ProfileTestNames=$profileNames; ActionEngineTestNames=$actionNames
        SelectedTestNames=$allNames; CatalogueCount=$catalogue.Count; ExpectedTotal=$selected.Count
    }
}

function Assert-ZentraNativeProfileVerificationProof {
    param([Parameter(Mandatory=$true)]$Plan,
        [Parameter(Mandatory=$true)][AllowEmptyCollection()][object[]]$SuiteExecutions,
        [Parameter(Mandatory=$true)][AllowEmptyCollection()][string[]]$StdoutTexts,
        [Parameter(Mandatory=$true)][AllowEmptyCollection()][AllowEmptyString()][string[]]$StderrTexts)
    if ($Plan.ProfileTestNames.Count -ne 26 -or $Plan.ExpectedTotal -cnotin @(26,265) -or
        $SuiteExecutions.Count -ne $Plan.Filters.Count -or $StdoutTexts.Count -ne $Plan.Filters.Count -or $StderrTexts.Count -ne $Plan.Filters.Count) {
        throw 'The native profile proof is incomplete.'
    }
    $total = 0
    for ($index = 0; $index -lt $Plan.Filters.Count; $index++) {
        $filter = $Plan.Filters[$index]
        $execution = $SuiteExecutions[$index]
        $stdoutName = 'windows-test-suite-{0:D2}.log' -f ($index + 1)
        $stderrName = 'windows-test-suite-{0:D2}-errors.log' -f ($index + 1)
        if ($execution.filter -cne $filter.Name -or $execution.contextMode -cne 'diagnostics-verification' -or
            $execution.stdout -cne $stdoutName -or $execution.stderr -cne $stderrName) {
            throw 'The native profile proof has a different filter, order, context or fixed log name.'
        }
        foreach ($sequence in @(
            @{Actual=@($execution.extraArguments);Expected=@($filter.Arguments)},
            @{Actual=@($execution.nativeArguments);Expected=(@($filter.Name,'--test-threads=1') + @($filter.Arguments))}
        )) {
            if ($sequence.Actual.Count -ne $sequence.Expected.Count) { throw 'Native profile arguments changed.' }
            for ($argument = 0; $argument -lt $sequence.Expected.Count; $argument++) {
                if ($sequence.Actual[$argument] -cne $sequence.Expected[$argument]) { throw 'Native profile arguments changed.' }
            }
        }
        foreach ($field in @('exit','failed','ignored','selectedNames','passed')) {
            if ($execution.$field -isnot [int] -and $execution.$field -isnot [long]) { throw 'Native profile counters must be actual integer results.' }
        }
        if ($execution.exit -ne 0 -or $execution.failed -ne 0 -or $execution.ignored -ne 0 -or
            $execution.selectedNames -ne $filter.ExpectedCount -or $execution.passed -ne $filter.ExpectedCount) {
            throw 'Every selected native profile test must pass without ignoring any test.'
        }
        $text = $StdoutTexts[$index]
        $summaries = [regex]::Matches($text, '(?m)^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in [0-9.]+s\r?$')
        $running = [regex]::Matches($text, '(?m)^running (\d+) tests?\r?$')
        $results = [regex]::Matches($text, '(?m)^test ([A-Za-z_][A-Za-z0-9_:]*) \.\.\. (\S+)\r?$')
        if ($summaries.Count -ne 1 -or $running.Count -ne 1 -or $results.Count -ne $filter.ExpectedCount -or
            [regex]::Matches($text, '(?m)^test .*\r?$').Count -ne ($filter.ExpectedCount + 1) -or
            [regex]::Matches($text, '(?m)^running .*\r?$').Count -ne 1 -or
            -not [string]::IsNullOrWhiteSpace($StderrTexts[$index])) { throw 'Native profile logs are missing, ambiguous or contain unexpected stderr.' }
        $summary = $summaries[0]
        if (-not [string]::IsNullOrWhiteSpace($text.Substring($summary.Index + $summary.Length))) {
            throw 'The sole native profile result summary must be terminal.'
        }
        if ($summary.Groups[1].Value -cne 'ok' -or [int]$summary.Groups[2].Value -ne $filter.ExpectedCount -or
            [int]$summary.Groups[3].Value -ne 0 -or [int]$summary.Groups[4].Value -ne 0 -or [int]$summary.Groups[5].Value -ne 0 -or
            [int]$summary.Groups[6].Value -ne ($Plan.CatalogueCount - $filter.ExpectedCount) -or
            [int]$running[0].Groups[1].Value -ne $filter.ExpectedCount) { throw 'Native profile log counts do not corroborate the actual catalogue.' }
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($result in $results) {
            $name = $result.Groups[1].Value
            if ($result.Index -le $running[0].Index -or $result.Index -ge $summary.Index -or
                $result.Groups[2].Value -cne 'ok' -or $name -cnotin $filter.TestNames -or -not $seen.Add($name)) {
                throw 'Native profile logs contain a missing, duplicate, replaced or unsuccessful test.'
            }
        }
        $total += $execution.passed
    }
    if ($total -ne $Plan.ExpectedTotal) { throw 'The native profile runtime total does not corroborate the selection.' }
    return [pscustomobject]@{TotalPassed=$total;ProfilePassed=26;ActionEnginePassed=$Plan.ActionEngineTestNames.Count;RuntimeNamesAndCountsCorroborated=$true}
}
