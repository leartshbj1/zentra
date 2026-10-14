# Function definitions only. The admitted CI entrypoint owns compilation and
# execution; importing this file does not launch a tool or contact a service.
function Get-ZentraAutopilotProductPlan {
    param([Parameter(Mandatory=$true)][string[]]$TestNames)
    $prefix = 'account_cloud::action_engine::supervisor::tests::'
    $suffixes = @(
        'product_gate_is_closed_before_context_or_transport'
        'ipc_origin_requires_both_exact_local_generations'
        'retained_round_rejects_session_nonce_reference_and_role_changes'
        'physical_singleflight_survives_dropped_ipc_waiter_and_allows_consent_withdrawal'
        'review_and_recovery_summaries_are_distinct_from_confirmed_activity'
        'consent_cas_and_read_dtos_refuse_extra_fields_versions_and_revision_overflow'
        'review_pages_are_bounded_same_company_and_never_expose_decisions'
        'server_failures_map_to_closed_codes_without_response_text'
        'product_routes_are_fixed_first_party_https_without_sites_credentials'
    )
    $selected = @($suffixes | ForEach-Object { $prefix + $_ })
    $actual = @($TestNames | Where-Object { $_.StartsWith($prefix,[StringComparison]::Ordinal) })
    if ($actual.Count -ne 9 -or @($actual | Select-Object -Unique).Count -ne 9 -or
        @($selected | Where-Object { $_ -cnotin $actual }).Count -ne 0) {
        throw 'The Autopilot product test catalogue differs from the reviewed exact nine tests.'
    }
    return [pscustomobject]@{ SelectedNames=[string[]]$selected; ExpectedTotal=9 }
}

function Invoke-ZentraAutopilotProductVerification {
    param([Parameter(Mandatory=$true)]$Harness, [Parameter(Mandatory=$true)][string]$Source,
        [Parameter(Mandatory=$true)][string]$ProfileSha256, [Parameter(Mandatory=$true)][string]$Artifacts)
    $plan = Get-ZentraAutopilotProductPlan -TestNames $Harness.TestNames
    $proof = [ordered]@{
        format='zentra-autopilot-product-native-tests-v1'; source=$Source;
        binarySha256=$Harness.ExpectedSha256; profileSha256=$ProfileSha256;
        selectedNames=$plan.SelectedNames; expectedTotal=9; runtimePassed=0;
        nativeExecutionAttempted=$false; passed=$false; opensProduct=$false;
        businessJourneyExecuted=$false; releasePublished=$false; suiteExecutions=@()
    }
    $start = $Harness.Proof.suiteExecutions.Count
    if ($start -ne 11) { throw 'Autopilot tests require the same compiled binary after the eleven exact profile tests.' }
    try {
        foreach ($name in $plan.SelectedNames) {
            $proof.nativeExecutionAttempted=$true
            Invoke-ZentraVerificationSuite $Harness $name @('--exact')
            $index=$start+$proof.runtimePassed
            $execution=$Harness.Proof.suiteExecutions[$index]
            Assert-ZentraLiveProfileSuite -Execution $execution -Name $name -CatalogueCount $Harness.TestNames.Count -Index ($index+1) `
                -Stdout ([IO.File]::ReadAllText((Join-Path $Artifacts ('windows-test-suite-{0:D2}.log' -f ($index+1))))) `
                -Stderr ([IO.File]::ReadAllText((Join-Path $Artifacts ('windows-test-suite-{0:D2}-errors.log' -f ($index+1)))))
            $proof.runtimePassed++
        }
        if ($proof.runtimePassed -ne 9 -or $Harness.Proof.suiteExecutions.Count -ne 20) { throw 'The native Autopilot product proof is incomplete.' }
        $proof.passed=$true
    } finally {
        $proof.suiteExecutions=@($Harness.Proof.suiteExecutions | Select-Object -Skip $start)
        Save-ZentraHarnessProof $proof (Join-Path $Artifacts 'autopilot-product-native-proof.json')
    }
    return $proof
}
