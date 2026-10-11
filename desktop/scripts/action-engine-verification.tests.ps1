# Pure PowerShell behavioral tests with a SYNTHETIC libtest catalogue and
# SYNTHETIC result records. These never run or prove any Rust/native tests.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'action-engine-verification.ps1')
$script:passed = 0
function Assert-Behavior {
    param([bool]$Condition, [string]$Name)
    if (-not $Condition) { throw "Action Engine selection behavior failed: $Name" }
    $script:passed++
}
function Assert-Refused {
    param([scriptblock]$Action, [string]$Name)
    $refused = $false
    try { $null = & $Action } catch { $refused = $true }
    Assert-Behavior $refused $Name
}
function New-SyntheticCatalogue {
    $counts = [ordered]@{
        'action_engine_resources::tests::'=20; 'action_engine_quote::tests::'=67
        'action_engine_device_protocol::tests::'=33; 'account_cloud::action_engine::tests::'=29
        'backup::action_engine_archive_tests::'=4; 'company_collaboration::action_engine_collaboration_tests::'=3
        'company_collaboration::action_publication_tests::'=17; 'company_collaboration::action_execution_tests::'=8
        'company_collaboration::publication_recovery_tests::'=13; 'backup::recovery_tests::'=5
        'company_collaboration::reference_worker_tests::'=10; 'company_collaboration::content_version_compat_tests::'=7
        'company_collaboration::merge_version_compat_tests::'=3; 'backup::recovery_crash_tests::'=19
    }
    foreach ($prefix in $counts.Keys) { for ($i=0; $i -lt $counts[$prefix]; $i++) { "$($prefix)synthetic_$i" } }
    'company_merge::tests::actual_v60_and_v61_references_merge_v62_branches_receipts_and_republish_fresh_resources'
    'backup::recovery_crash_tests::native_crash_child'
    'backup::recovery_crash_tests::native_crash_boundaries_restore_one_complete_profile_before_migration'
    'unrelated::tests::synthetic_unselected'
}
function New-SyntheticExecutions {
    param($Plan)
    foreach ($filter in $Plan.Filters) {
        [pscustomobject]@{
            filter=$filter.Name; contextMode='diagnostics-verification'
            extraArguments=[string[]]@($filter.Arguments)
            nativeArguments=[string[]](@($filter.Name, '--test-threads=1') + @($filter.Arguments))
            exit=0; failed=0; ignored=0; selectedNames=$filter.ExpectedCount; passed=$filter.ExpectedCount
        }
    }
}
$catalogue = @(New-SyntheticCatalogue)
$original = $catalogue -join "`n"
$plan = Get-ZentraActionEngineVerificationPlan -TestNames $catalogue
Assert-Behavior ($plan.Filters.Count -eq 33) 'ten core and twenty-three complementary filters'
Assert-Behavior ($plan.CoreTestNames.Count -eq 195 -and $plan.RegressionTestNames.Count -eq 44) 'reviewed distinct groups'
Assert-Behavior ($plan.SelectedTestNames.Count -eq 239 -and @($plan.SelectedTestNames | Sort-Object -Unique).Count -eq 239) 'each selected name occurs once'
Assert-Behavior (($catalogue -join "`n") -ceq $original) 'caller catalogue is not mutated'
Assert-Behavior ((Get-ZentraActionEngineVerificationPlan -TestNames @($catalogue + 'unrelated_root_test')).SelectedTestNames.Count -eq 239) 'valid root-level libtest name is allowed and unselected'
Assert-Behavior (@($plan.SelectedTestNames | Where-Object { $_ -in $plan.ExcludedProcessKillTestNames }).Count -eq 0) 'process-kill entry points are excluded'
Assert-Behavior (@($plan.Filters | Where-Object { $_.Arguments -contains '--include-ignored' }).Count -eq 0) 'ignored tests are never enabled'
$exact = @($plan.Filters | Where-Object { $_.Arguments -contains '--exact' })
Assert-Behavior ($exact.Count -eq 20 -and @($exact | Where-Object { $_.ExpectedCount -ne 1 }).Count -eq 0) 'merge and recovery exact filters select one each'
$summary = Assert-ZentraActionEngineVerificationProof -Plan $plan -SuiteExecutions @(New-SyntheticExecutions $plan)
Assert-Behavior ($summary.CorePassed -eq 195 -and $summary.RegressionPassed -eq 44 -and $summary.TotalPassed -eq 239 -and $summary.RuntimeCatalogCorroborated) 'synthetic successful counters corroborate the synthetic plan'
Assert-Refused { Get-ZentraActionEngineVerificationPlan -TestNames @($catalogue + $catalogue[0]) } 'duplicate catalogue name'
Assert-Refused { Get-ZentraActionEngineVerificationPlan -TestNames @($catalogue + 'invalid name') } 'invalid catalogue name'
Assert-Refused { Get-ZentraActionEngineVerificationPlan -TestNames @($catalogue | Where-Object { $_ -cne $catalogue[0] }) } 'missing core test'
Assert-Refused { Get-ZentraActionEngineVerificationPlan -TestNames @($catalogue + 'action_engine_quote::tests::new_unreviewed_test') } 'unexpected additional core test'
Assert-Refused { Get-ZentraActionEngineVerificationPlan -TestNames @($catalogue | Where-Object { $_ -notlike 'backup::recovery_tests::*' }) } 'empty complementary filter'
Assert-Refused { Get-ZentraActionEngineVerificationPlan -TestNames @($catalogue | Where-Object { $_ -cne 'backup::recovery_crash_tests::native_crash_child' }) } 'missing reviewed process-kill exclusion'
$replaced = @($catalogue | Where-Object { $_ -cne 'backup::recovery_crash_tests::native_crash_child' }) + 'backup::recovery_crash_tests::other_child'
Assert-Refused { Get-ZentraActionEngineVerificationPlan -TestNames $replaced } 'same count cannot replace an excluded entry point'
$mergeNearMatch = $catalogue + 'company_merge::tests::actual_v60_and_v61_references_merge_v62_branches_receipts_and_republish_fresh_resources_extra'
$nearMatchPlan = Get-ZentraActionEngineVerificationPlan -TestNames $mergeNearMatch
Assert-Behavior ($nearMatchPlan.SelectedTestNames.Count -eq 239) 'exact merge selection ignores a substring near match'
$overlap = @($catalogue | Where-Object { $_ -cne 'action_engine_quote::tests::synthetic_0' -and $_ -cne 'action_engine_resources::tests::synthetic_0' }) + 'action_engine_quote::tests::action_engine_resources::tests::synthetic_overlap'
Assert-Refused { Get-ZentraActionEngineVerificationPlan -TestNames $overlap } 'matching counts still refuse overlapping substring filters'
$cases = @(
    @{Name='nonzero exit'; Change={ param($r) $r[0].exit=1 }},
    @{Name='failed test'; Change={ param($r) $r[0].failed=1 }},
    @{Name='ignored test'; Change={ param($r) $r[0].ignored=1 }},
    @{Name='partial pass'; Change={ param($r) $r[0].passed-- }},
    @{Name='zero pass'; Change={ param($r) $r[0].passed=0 }},
    @{Name='different selected count'; Change={ param($r) $r[0].selectedNames++ }},
    @{Name='null exit cannot become zero'; Change={ param($r) $r[0].exit=$null }},
    @{Name='string counter cannot become a numeric pass'; Change={ param($r) $r[0].passed='20' }},
    @{Name='wrong filter'; Change={ param($r) $r[0].filter='other::test' }},
    @{Name='wrong context'; Change={ param($r) $r[0].contextMode='release-preflight' }},
    @{Name='changed ordering'; Change={ param($r) $temp=$r[0]; $r[0]=$r[1]; $r[1]=$temp }},
    @{Name='missing exact flag'; Change={ param($r) $r[9].extraArguments=[string[]]@() }},
    @{Name='changed actual arguments'; Change={ param($r) $r[9].nativeArguments=[string[]]@($r[9].filter,'--test-threads=1') }},
    @{Name='ignored enabled in actual invocation'; Change={ param($r) $r[0].nativeArguments += '--include-ignored' }},
    @{Name='different case in filter'; Change={ param($r) $r[0].filter=$r[0].filter.ToUpperInvariant() }},
    @{Name='missing result field'; Change={ param($r) $r[0].PSObject.Properties.Remove('passed') }}
)
foreach ($case in $cases) {
    $records = @(New-SyntheticExecutions $plan)
    $null = & $case.Change $records
    Assert-Refused { Assert-ZentraActionEngineVerificationProof -Plan $plan -SuiteExecutions $records } $case.Name
}
$records = @(New-SyntheticExecutions $plan)
Assert-Refused { Assert-ZentraActionEngineVerificationProof -Plan $plan -SuiteExecutions @($records | Select-Object -Skip 1) } 'missing suite'
Assert-Refused { Assert-ZentraActionEngineVerificationProof -Plan $plan -SuiteExecutions @($records + $records[0]) } 'extra suite'
Assert-Refused { Assert-ZentraActionEngineVerificationProof -Plan $plan -SuiteExecutions @() } 'empty proof'
Write-Host "Action Engine pure selection/proof behaviors: $script:passed passed. Synthetic records only; no native execution."
