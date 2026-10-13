# CI admission, selection, result checks and explicit evidence transport. Dot-sourcing never runs tools,
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
        ExpectedTotal=$(if ($index -eq 0) {271} else {32})
        ArtifactDirectory=('node-{0}-{1}' -f $index,$name)
        PipelineId=$Context['ZENTRA_NATIVE_PROFILE_PIPELINE_ID']
        WorkflowId=$Context['CIRCLE_WORKFLOW_ID']; JobNumber=$Context['CIRCLE_BUILD_NUM']
    }
}

function Assert-ZentraNativeProfileTransportRelativePath {
    param([Parameter(Mandatory=$true)][AllowEmptyString()][string]$Path)
    if ($Path.Length -gt 240 -or $Path -cnotmatch '\A[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*\z') {
        throw 'Native profile transport requires bounded ordinary relative file paths.'
    }
    foreach ($part in $Path.Split('/')) {
        if ($part -in @('.','..') -or $part.EndsWith('.') -or
            $part -match '\A(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|\z)') {
            throw 'Native profile transport refuses ambiguous Windows path components.'
        }
    }
}

function Get-ZentraNativeProfileTransportPlan {
    param([Parameter(Mandatory=$true)][Collections.IDictionary]$Context,
        [Parameter(Mandatory=$true)][AllowEmptyCollection()][object[]]$Files)
    Assert-ZentraNativeProfileAdmission -Context $Context
    $node = Get-ZentraNativeProfileNodePlan -Context $Context
    if ($Files.Count -lt 1 -or $Files.Count -gt 512) { throw 'Native profile transport requires one bounded file inventory.' }
    $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $total = [long]0
    foreach ($file in $Files) {
        if ($file.path -isnot [string]) { throw 'Native profile transport requires actual relative path strings.' }
        Assert-ZentraNativeProfileTransportRelativePath -Path $file.path
        if (-not $paths.Add($file.path) -or ($file.bytes -isnot [int] -and $file.bytes -isnot [long]) -or
            $file.bytes -lt 0 -or $file.bytes -gt 134217728) { throw 'Native profile transport refuses collisions or unbounded file sizes.' }
        $total += $file.bytes
        if ($total -gt 268435456) { throw 'Native profile transport exceeds the complete inventory byte limit.' }
    }
    foreach ($path in $paths) {
        $parent = $path
        while ($parent.Contains('/')) {
            $parent = $parent.Substring(0,$parent.LastIndexOf('/'))
            if ($paths.Contains($parent)) { throw 'Native profile transport refuses file/directory collisions.' }
        }
    }
    if (@($Files | Where-Object { $_.path -ceq 'native-profile-verification-proof.json' }).Count -ne 1) { throw 'Native profile transport requires the final node proof in its real inventory.' }
    $orderedPaths = [string[]]@($paths)
    [Array]::Sort($orderedPaths,[StringComparer]::Ordinal)
    return [pscustomobject]@{
        Node=$node; Paths=$orderedPaths; TotalBytes=$total
        ZipName=($node.ArtifactDirectory + '-evidence.zip')
        ReceiptName=($node.ArtifactDirectory + '-evidence.receipt.json')
    }
}

function Assert-ZentraNativeProfileTransportOrdinaryPath {
    param([Parameter(Mandatory=$true)][string]$Path, [switch]$Directory)
    $current = [IO.Path]::GetFullPath($Path)
    $first = $true
    while (-not [string]::IsNullOrEmpty($current)) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        $expectDirectory = -not $first -or $Directory.IsPresent
        if (($expectDirectory -and $item -isnot [IO.DirectoryInfo]) -or
            (-not $expectDirectory -and $item -isnot [IO.FileInfo]) -or
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $null -eq $item.PSObject.Properties['LinkType'] -or -not [string]::IsNullOrEmpty($item.LinkType)) {
            throw 'Native profile transport requires ordinary files and directories without linked ancestors.'
        }
        $first = $false
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Get-ZentraNativeProfileTransportInventory {
    param([Parameter(Mandatory=$true)][string]$NodePath)
    Assert-ZentraNativeProfileTransportOrdinaryPath -Path $NodePath -Directory
    $prefix = [IO.Path]::GetFullPath($NodePath).TrimEnd([char[]]@('\','/')) + [IO.Path]::DirectorySeparatorChar
    $pending = [Collections.Generic.Queue[string]]::new()
    $pending.Enqueue($NodePath)
    $files = [Collections.Generic.List[object]]::new()
    $directories = 1
    while ($pending.Count -gt 0) {
        $directory = $pending.Dequeue()
        Assert-ZentraNativeProfileTransportOrdinaryPath -Path $directory -Directory
        $entries = [IO.Directory]::EnumerateFileSystemEntries($directory).GetEnumerator()
        try {
            while ($entries.MoveNext()) {
                $fullPath = [IO.Path]::GetFullPath($entries.Current)
                if (-not $fullPath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'Native profile transport refuses a path outside its node directory.' }
                $relative = $fullPath.Substring($prefix.Length).Replace('\','/')
                Assert-ZentraNativeProfileTransportRelativePath -Path $relative
                $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
                Assert-ZentraNativeProfileTransportOrdinaryPath -Path $fullPath -Directory:($item -is [IO.DirectoryInfo])
                if ($item -is [IO.DirectoryInfo]) {
                    $directories++
                    if ($directories -gt 512) { throw 'Native profile transport exceeds the directory limit.' }
                    $pending.Enqueue($fullPath)
                } else {
                    $files.Add([pscustomobject]@{path=$relative;bytes=$item.Length;fullPath=$fullPath})
                    if ($files.Count -gt 512) { throw 'Native profile transport exceeds the file limit.' }
                }
            }
        } finally { $entries.Dispose() }
    }
    return $files.ToArray()
}

function Assert-ZentraNativeProfileTransportSource {
    param([Parameter(Mandatory=$true)][string]$Repository, [Parameter(Mandatory=$true)][string]$Source)
    $head = @(& git -C $Repository rev-parse HEAD)
    if ($LASTEXITCODE -ne 0 -or $head.Count -ne 1 -or $head[0] -cne $Source) {
        throw 'Native profile transport requires HEAD to remain the exact admitted CircleCI source.'
    }
}

function Write-ZentraNativeProfileTransportBundle {
    param([Parameter(Mandatory=$true)][Collections.IDictionary]$Context,
        [Parameter(Mandatory=$true)][string]$Repository, [Parameter(Mandatory=$true)][string]$ArtifactRoot)
    # Admission and unchanged source precede all evidence reads and output creation.
    Assert-ZentraNativeProfileAdmission -Context $Context
    Assert-ZentraNativeProfileTransportSource -Repository $Repository -Source $Context['CIRCLE_SHA1']
    $node = Get-ZentraNativeProfileNodePlan -Context $Context
    Assert-ZentraNativeProfileTransportOrdinaryPath -Path $ArtifactRoot -Directory
    $nodePath = Join-Path $ArtifactRoot $node.ArtifactDirectory
    $files = @(Get-ZentraNativeProfileTransportInventory -NodePath $nodePath)
    $plan = Get-ZentraNativeProfileTransportPlan -Context $Context -Files $files
    $zipPath = Join-Path $ArtifactRoot $plan.ZipName
    $receiptPath = Join-Path $ArtifactRoot $plan.ReceiptName
    if (Test-Path -LiteralPath $zipPath) { throw 'Native profile transport ZIP must be fresh.' }
    if (Test-Path -LiteralPath $receiptPath) { throw 'Native profile transport receipt must be fresh.' }
    Add-Type -AssemblyName System.IO.Compression
    $streams = [Collections.Generic.Dictionary[string,IO.FileStream]]::new([StringComparer]::Ordinal)
    $inventory = @()
    $zipStream=$null; $archive=$null; $receiptStream=$null; $hash=$null
    try {
        # Keep every admitted source open with no write/delete sharing through ZIP creation.
        foreach ($path in $plan.Paths) {
            $file = @($files | Where-Object { $_.path -ceq $path })[0]
            Assert-ZentraNativeProfileTransportOrdinaryPath -Path $file.fullPath
            $stream = [IO.FileStream]::new($file.fullPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
            $streams.Add($path,$stream)
            if ($stream.Length -ne $file.bytes) { throw 'Native profile transport source size changed.' }
        }
        $hash = [Security.Cryptography.SHA256]::Create()
        foreach ($path in $plan.Paths) {
            $stream = $streams[$path]
            $sha = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant()
            $inventory += [ordered]@{path=$path;bytes=$stream.Length;sha256=$sha}
            $stream.Position = 0
        }
        $zipStream = [IO.FileStream]::new($zipPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        $archive = [IO.Compression.ZipArchive]::new($zipStream,[IO.Compression.ZipArchiveMode]::Create,$true)
        foreach ($path in $plan.Paths) {
            $entry = $archive.CreateEntry($path,[IO.Compression.CompressionLevel]::Optimal)
            $destination = $entry.Open()
            try { $streams[$path].CopyTo($destination) } finally { $destination.Dispose() }
        }
        $archive.Dispose(); $archive=$null
        $zipStream.Flush($true)
        $after = @(Get-ZentraNativeProfileTransportInventory -NodePath $nodePath)
        $afterPlan = Get-ZentraNativeProfileTransportPlan -Context $Context -Files $after
        if ($afterPlan.Paths.Count -ne $plan.Paths.Count -or $afterPlan.TotalBytes -ne $plan.TotalBytes -or
            [string]::Join("`n",$afterPlan.Paths) -cne [string]::Join("`n",$plan.Paths)) { throw 'Native profile transport inventory changed during capture.' }
        Assert-ZentraNativeProfileTransportSource -Repository $Repository -Source $Context['CIRCLE_SHA1']
        if ($zipStream.Length -lt 1 -or $zipStream.Length -gt 269484032) { throw 'Native profile transport ZIP exceeds its complete bound.' }
        $zipStream.Position = 0
        $zipSha = [BitConverter]::ToString($hash.ComputeHash($zipStream)).Replace('-','').ToLowerInvariant()
        $receipt = [ordered]@{
            kind='isolated-native-test-profile-transport-receipt';schemaVersion=1
            source=$Context['CIRCLE_SHA1'];circleSource=$Context['CIRCLE_SHA1']
            pipelineId=$node.PipelineId;workflowId=$node.WorkflowId;jobNumber=$node.JobNumber
            nodeIndex=$node.NodeIndex;nodeTotal=$node.NodeTotal;context=$node.Context
            nodeDirectory=$node.ArtifactDirectory;finalProofPath='native-profile-verification-proof.json'
            fileCount=$inventory.Count;totalBytes=$plan.TotalBytes;files=$inventory
            zip=[ordered]@{path=$plan.ZipName;bytes=$zipStream.Length;sha256=$zipSha}
        }
        $receiptBytes = [Text.UTF8Encoding]::new($false).GetBytes(($receipt | ConvertTo-Json -Depth 6))
        $receiptStream = [IO.FileStream]::new($receiptPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        $receiptStream.Write($receiptBytes,0,$receiptBytes.Length)
        $receiptStream.Flush($true)
        return [pscustomobject]@{ZipPath=$zipPath;ReceiptPath=$receiptPath;FileCount=$inventory.Count;TotalBytes=$plan.TotalBytes;ZipSha256=$zipSha}
    } finally {
        if ($null -ne $receiptStream) { $receiptStream.Dispose() }
        if ($null -ne $archive) { $archive.Dispose() }
        if ($null -ne $zipStream) { $zipStream.Dispose() }
        if ($null -ne $hash) { $hash.Dispose() }
        foreach ($stream in $streams.Values) { $stream.Dispose() }
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
            'sites_access_header_is_sensitive_and_preserves_device_authorization_and_body'
            'sites_access_rejects_invalid_tokens_without_retaining_them'
            'sites_access_installation_requires_a_valid_manifest_and_is_immutable'
            'sites_access_refuses_foreign_production_and_non_https_destinations'
            'sites_access_refuses_invalid_missing_profiles_and_preexisting_header'
            'sites_access_preserves_site_paths_and_ordinary_tests_without_a_token'
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
    if ($Plan.ProfileTestNames.Count -ne 32 -or $Plan.ExpectedTotal -cnotin @(32,271) -or
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
    return [pscustomobject]@{TotalPassed=$total;ProfilePassed=32;ActionEnginePassed=$Plan.ActionEngineTestNames.Count;RuntimeNamesAndCountsCorroborated=$true}
}
