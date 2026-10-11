# Pure selection/proof helpers. Importing this file never compiles, launches a
# process, touches application data or contacts a service. TestNames must come
# from the prepared library harness's actual libtest --list output.
function Get-ZentraActionEngineVerificationPlan {
    param([Parameter(Mandatory=$true)][string[]]$TestNames)
    Set-StrictMode -Version Latest
    $catalog = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($name in $TestNames) {
        if ($name -cnotmatch '^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*$' -or -not $catalog.Add($name)) {
            throw 'The native test catalogue contains an invalid or duplicate name.'
        }
    }
    $specifications = @(
        @{Name='action_engine_resources::tests::'; Count=20; Group='core'},
        @{Name='action_engine_quote::tests::'; Count=67; Group='core'},
        @{Name='action_engine_device_protocol::tests::'; Count=33; Group='core'},
        @{Name='account_cloud::action_engine::tests::'; Count=29; Group='core'},
        @{Name='backup::action_engine_archive_tests::'; Count=4; Group='core'},
        @{Name='company_collaboration::action_engine_collaboration_tests::'; Count=3; Group='core'},
        @{Name='company_collaboration::action_publication_tests::'; Count=17; Group='core'},
        @{Name='company_collaboration::action_execution_tests::'; Count=8; Group='core'},
        @{Name='company_collaboration::publication_recovery_tests::'; Count=13; Group='core'},
        @{Name='company_merge::tests::actual_v60_and_v61_references_merge_v62_branches_receipts_and_republish_fresh_resources'; Count=1; Group='core'; Exact=$true},
        @{Name='backup::recovery_tests::'; Count=5; Group='regression'},
        @{Name='company_collaboration::reference_worker_tests::'; Count=10; Group='regression'},
        @{Name='company_collaboration::content_version_compat_tests::'; Count=7; Group='regression'},
        @{Name='company_collaboration::merge_version_compat_tests::'; Count=3; Group='regression'}
    )
    $crashPrefix = 'backup::recovery_crash_tests::'
    $excluded = @(
        ($crashPrefix + 'native_crash_child'),
        ($crashPrefix + 'native_crash_boundaries_restore_one_complete_profile_before_migration')
    )
    $crashNames = @($TestNames | Where-Object { $_.Contains($crashPrefix) })
    if ($crashNames.Count -ne 21 -or @($excluded | Where-Object { -not $catalog.Contains($_) }).Count -ne 0) {
        throw 'The recovery catalogue no longer matches the reviewed process-kill exclusions.'
    }
    [Array]::Sort($crashNames, [StringComparer]::Ordinal)
    foreach ($name in $crashNames) {
        if ($name -cnotin $excluded) {
            $specifications += @{Name=$name; Count=1; Group='regression'; Exact=$true}
        }
    }
    $selected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $core = [Collections.Generic.List[string]]::new()
    $regression = [Collections.Generic.List[string]]::new()
    $filters = @()
    foreach ($specification in $specifications) {
        $exact = $specification.ContainsKey('Exact') -and $specification.Exact
        # Match libtest and the existing native harness: substring unless exact.
        $names = @($TestNames | Where-Object {
            if ($exact) { $_ -ceq $specification.Name } else { $_.Contains($specification.Name) }
        })
        if ($names.Count -ne $specification.Count) {
            throw "Native selection count changed for $($specification.Name): expected $($specification.Count), found $($names.Count)."
        }
        foreach ($name in $names) {
            if (-not $selected.Add($name)) { throw 'Native verification filters overlap.' }
            if ($specification.Group -ceq 'core') { $core.Add($name) } else { $regression.Add($name) }
        }
        $arguments = [string[]]@()
        if ($exact) { $arguments = [string[]]@('--exact') }
        $filters += [pscustomobject]@{
            Name=$specification.Name
            Arguments=$arguments
            Group=$specification.Group
            ExpectedCount=$specification.Count
        }
    }
    if ($core.Count -ne 195 -or $regression.Count -ne 44 -or $selected.Count -ne 239) {
        throw 'The reviewed Action Engine native selection is incomplete.'
    }
    $allNames = [string[]]@($selected)
    [Array]::Sort($allNames, [StringComparer]::Ordinal)
    return [pscustomobject]@{
        Filters=$filters
        CoreTestNames=[string[]]$core.ToArray()
        RegressionTestNames=[string[]]$regression.ToArray()
        SelectedTestNames=$allNames
        ExpectedCoreCount=195
        ExcludedProcessKillTestNames=$excluded
    }
}

function Assert-ZentraActionEngineVerificationProof {
    param([Parameter(Mandatory=$true)]$Plan, [Parameter(Mandatory=$true)][AllowEmptyCollection()][object[]]$SuiteExecutions)
    Set-StrictMode -Version Latest
    if ($Plan.ExpectedCoreCount -ne 195 -or $Plan.CoreTestNames.Count -ne 195 -or
        $Plan.RegressionTestNames.Count -ne 44 -or $Plan.SelectedTestNames.Count -ne 239 -or
        $SuiteExecutions.Count -ne $Plan.Filters.Count) {
        throw 'The native verification proof is incomplete.'
    }
    $corePassed = 0
    $regressionPassed = 0
    for ($index = 0; $index -lt $Plan.Filters.Count; $index++) {
        $filter = $Plan.Filters[$index]
        $execution = $SuiteExecutions[$index]
        if ($execution.filter -cne $filter.Name -or $execution.contextMode -cne 'diagnostics-verification') {
            throw 'The native verification proof contains a different filter, order or context.'
        }
        $expectedNativeArguments = @($filter.Name, '--test-threads=1') + @($filter.Arguments)
        foreach ($sequence in @(
            @{Actual=@($execution.extraArguments); Expected=@($filter.Arguments)},
            @{Actual=@($execution.nativeArguments); Expected=$expectedNativeArguments}
        )) {
            if ($sequence.Actual.Count -ne $sequence.Expected.Count) { throw 'Native verification arguments changed.' }
            for ($argument = 0; $argument -lt $sequence.Expected.Count; $argument++) {
                if ($sequence.Actual[$argument] -cne $sequence.Expected[$argument]) { throw 'Native verification arguments changed.' }
            }
        }
        foreach ($field in @('exit','failed','ignored','selectedNames','passed')) {
            $value = $execution.$field
            if ($value -isnot [int] -and $value -isnot [long]) { throw 'The native proof has a missing or invalid result counter.' }
        }
        if ($execution.exit -ne 0 -or $execution.failed -ne 0 -or $execution.ignored -ne 0 -or
            $execution.selectedNames -ne $filter.ExpectedCount -or $execution.passed -ne $filter.ExpectedCount) {
            throw "The native suite did not execute every selected test successfully: $($filter.Name)."
        }
        if ($filter.Group -ceq 'core') { $corePassed += $execution.passed } else { $regressionPassed += $execution.passed }
    }
    if ($corePassed -ne 195 -or $regressionPassed -ne 44) { throw 'The native execution totals do not corroborate the catalogue.' }
    return [pscustomobject]@{
        CorePassed=$corePassed
        RegressionPassed=$regressionPassed
        TotalPassed=$corePassed + $regressionPassed
        UniqueSelectedCount=$Plan.SelectedTestNames.Count
        RuntimeCatalogCorroborated=$true
    }
}
