#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$WrapperPath = (Join-Path $PSScriptRoot 'verify-native-recovery.ps1'),
  [string]$HarnessPath = (Join-Path $PSScriptRoot 'windows-verification-harness.ps1'),
  [Parameter(Mandatory=$true)][string]$EvidenceDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Parse the real source as data. Evaluate only the new selection statements
# against an inert stub, excluding this contract's own call and receipt guard.
# Never dot-source/evaluate the complete wrapper or harness; never fabricate CI.
$script:checks = 0
function Assert-Contract { param([bool]$Condition,[string]$Name); if (-not $Condition) { throw ('Startup selection contract failed: ' + $Name) }; $script:checks++ }
function Parse-Only { param([string]$Path); $tokens=$null; $errors=$null; $ast=[Management.Automation.Language.Parser]::ParseFile($Path,[ref]$tokens,[ref]$errors); Assert-Contract (@($errors).Count -eq 0) ('AST parses ' + [IO.Path]::GetFileName($Path)); return $ast }
function Normalize-ContractText { param([string]$Text); return [regex]::Replace($Text.Trim(),'\s+',' ') }
[IO.Directory]::CreateDirectory($EvidenceDirectory) | Out-Null
$resultPath = Join-Path $EvidenceDirectory 'contract-results.json'
if (Test-Path -LiteralPath $resultPath) { throw 'Startup contract evidence already exists; never overwrite it.' }
$wrapperAst = Parse-Only $WrapperPath
$harnessAst = Parse-Only $HarnessPath
$wrapperText = [IO.File]::ReadAllText($WrapperPath)
$blocks = [regex]::Matches($wrapperText,'(?ms)^  # BEGIN ZENTRA STARTUP SELECTION\r?\n(?<body>.*?)^  # END ZENTRA STARTUP SELECTION\r?\n')
Assert-Contract ($blocks.Count -eq 1) 'one real startup selection block; old absence is refused'
Assert-Contract ([regex]::Matches($wrapperText,'(?m)^  # (BEGIN|END) ZENTRA STARTUP SELECTION\r?$').Count -eq 2) 'no duplicated or orphan selection markers'
$outside = $wrapperText.Remove($blocks[0].Index,$blocks[0].Length).Replace("`r`n","`n")
$hash = [Security.Cryptography.SHA256]::Create()
try { $outsideSha256=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($outside)))).Replace('-','').ToLowerInvariant() }
finally { $hash.Dispose() }
Assert-Contract ($outsideSha256 -ceq '051cdfe7b2f74162240a88d5f8fdff373832f4b90c5c2bb306c4548b76d221b8') 'all historical wrapper text remains exact after removing the new block (line endings normalized only)'
$tokens=$null; $errors=$null
$blockAst = [Management.Automation.Language.Parser]::ParseInput($blocks[0].Groups['body'].Value,[ref]$tokens,[ref]$errors)
Assert-Contract (@($errors).Count -eq 0) 'new block parses without evaluating source'
$blockStatements = @($blockAst.EndBlock.Statements)
$expectedContractCall = @'
$proof.startupSelectionContracts = & (Join-Path $repo 'desktop/scripts/native-startup-selection.contract-tests.ps1') -WrapperPath (Join-Path $repo 'desktop/scripts/verify-native-recovery.ps1') -HarnessPath (Join-Path $repo 'desktop/scripts/windows-verification-harness.ps1') -EvidenceDirectory (Join-Path $artifacts 'startup-selection-contracts')
'@
$expectedReceiptGuard = @'
if ($proof.startupSelectionContracts.passed -ne $true -or $proof.startupSelectionContracts.nativeExecuted -ne $false -or $proof.startupSelectionContracts.powershellVersion -notmatch '^5\.1\.') { throw 'Startup selection contracts require the normal Windows PowerShell 5.1 CI runtime.' }
'@
Assert-Contract ($blockStatements.Count -gt 2 -and (Normalize-ContractText $blockStatements[0].Extent.Text) -ceq (Normalize-ContractText $expectedContractCall)) 'normal isolated script invocation precedes native selection, with fixed paths'
Assert-Contract ((Normalize-ContractText $blockStatements[1].Extent.Text) -ceq (Normalize-ContractText $expectedReceiptGuard)) 'CI requires a successful inert receipt from PowerShell 5.1'
$fixtureBody = ($blockStatements[2..($blockStatements.Count-1)].Extent.Text -join "`n")
$fixtureAst = [Management.Automation.Language.Parser]::ParseInput($fixtureBody,[ref]$tokens,[ref]$errors)
Assert-Contract (@($errors).Count -eq 0) 'selection statements alone parse'
$fixtureCommands = @($fixtureAst.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst]},$true))
Assert-Contract (@($fixtureCommands | Where-Object { $_.GetCommandName() -cnotin @('Where-Object','Invoke-ZentraVerificationSuite','Join-Path','ForEach-Object','Get-FileHash') }).Count -eq 0) 'fixtures cannot recurse into the contract or run a bootstrap/process/source command'
$fixtureMethods = @($fixtureAst.FindAll({param($node) $node -is [Management.Automation.Language.InvokeMemberExpressionAst]},$true))
foreach ($method in $fixtureMethods) {
  $allowedMethod = if ($method.Static) {
    ($method.Expression.Extent.Text -ceq '[IO.File]' -and $method.Member.Value -ceq 'ReadAllText') -or
    ($method.Expression.Extent.Text -ceq '[regex]' -and $method.Member.Value -ceq 'Matches')
  } else { $method.Member.Value -cin @('Contains','ToLowerInvariant') }
  Assert-Contract $allowedMethod 'extracted fixture has only known read/string/regex methods, no process or writer'
}
Assert-Contract (@($fixtureAst.FindAll({param($node) $node -is [Management.Automation.Language.ExitStatementAst] -or $node -is [Management.Automation.Language.ReturnStatementAst]},$true)).Count -eq 0) 'selection refuses by throw and cannot bypass outer finally'
function Suite-Calls { param($Ast); return @($Ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -ceq 'Invoke-ZentraVerificationSuite'},$true)) }
$calls = @(Suite-Calls $wrapperAst)
Assert-Contract ($calls.Count -eq 16) 'fifteen historical dispatch sites and one startup dispatch'
$addition = @($calls | Where-Object { $_.Extent.Text -ceq 'Invoke-ZentraVerificationSuite $harness $startupFilter' })
Assert-Contract ($addition.Count -eq 1 -and $addition[0].Extent.StartOffset -gt $calls[13].Extent.EndOffset -and $addition[0].Extent.EndOffset -lt $calls[15].Extent.StartOffset) 'one fixed startup dispatch after diagnostics and before crash'
$harnessText = [IO.File]::ReadAllText($HarnessPath)
Assert-Contract ($harnessText.Contains('-TimeoutSeconds 5400') -and $harnessText.Contains('-TimeoutSeconds 3600')) 'actual compile and suite budgets remain unchanged'
Assert-Contract ($harnessText.Contains('TestNames=$testNames;Proof=$proof;') -and $harnessText.Contains('suiteExecutions=@();prepared=$false')) 'use actual catalog and harness result fields'
$expected = @(
  'startup_recovery::tests::exact_origin_captures_every_variant_and_preserves_other_errors',
  'startup_recovery::tests::no_journal_happy_bool_and_refusal_priority_with_artificial_store',
  'startup_recovery::tests::invalid_journal_refuses_before_business_directories_identity_or_migration',
  'startup_recovery::tests::historical_hidden_profile_without_journal_never_creates_an_empty_company',
  'startup_recovery::tests::directory_and_post_recovery_database_failures_keep_historical_errors',
  'startup_recovery::tests::explicit_native_diagnostic_export_succeeds_or_refuses_without_business_store',
  'startup_recovery::tests::pending_blocked_preserves_active_previous_candidates_documents_and_logo',
  'startup_recovery::tests::real_recovery_database_and_validation_failures_are_tagged',
  'startup_recovery::tests::pending_valid_rolls_back_and_durable_phases_reopen_real_profiles',
  'startup_recovery::tests::durable_cleanup_io_refuses_boot_then_reopen_keeps_selected_profile'
)
$declared = @($fixtureAst.FindAll({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -ceq '$startupExpectedNames'},$true))
$expectedNamesText = '@( ' + (($expected | ForEach-Object { "'" + $_ + "'" }) -join ', ') + ' )'
Assert-Contract ($declared.Count -eq 1 -and (Normalize-ContractText $declared[0].Right.Extent.Text) -ceq $expectedNamesText) 'actual block declares the reviewed ten exact string literals only'
$repoRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $WrapperPath) '../..'))
$sourceText = [IO.File]::ReadAllText((Join-Path $repoRoot 'desktop/src-tauri/src/startup_recovery.rs'))
$sourceTests = @([regex]::Matches($sourceText,'((?:    #\[[^\r\n]+\]\r?\n)+)    fn ([a-z_]+)\(') | Where-Object { $_.Groups[1].Value.Contains('#[test]') })
$sourceNames = @($sourceTests | ForEach-Object { 'startup_recovery::tests::' + $_.Groups[2].Value })
Assert-Contract (($sourceNames -join "`n") -ceq ($expected -join "`n")) 'real source catalogue agrees with the fixed names'
Assert-Contract (@($sourceTests | Where-Object { $_.Groups[1].Value.Contains('#[cfg(windows)]') }).Count -eq 1 -and $sourceTests[-1].Groups[1].Value.Contains('#[cfg(windows)]')) 'the tenth source test remains Windows-specific'
Assert-Contract (@($sourceTests | Where-Object { $_.Groups[1].Value.Contains('#[ignore') }).Count -eq 0) 'no source startup test is ignored'
$script:receiptCases = @()
$receiptGuardBlock = [ScriptBlock]::Create($blockStatements[1].Extent.Text)
foreach ($case in @(
  @{name='normal Windows PowerShell 5.1 receipt';accept=$true;value=@{passed=$true;nativeExecuted=$false;powershellVersion='5.1.26100.9444'}},
  @{name='PowerShell 7 cannot certify CI5.1';accept=$false;value=@{passed=$true;nativeExecuted=$false;powershellVersion='7.6.5'}},
  @{name='failed contract receipt';accept=$false;value=@{passed=$false;nativeExecuted=$false;powershellVersion='5.1.26100.9444'}},
  @{name='native-executed contract receipt';accept=$false;value=@{passed=$true;nativeExecuted=$true;powershellVersion='5.1.26100.9444'}},
  @{name='incomplete contract receipt';accept=$false;value=@{passed=$true}},
  @{name='null contract receipt';accept=$false;value=$null},
  @{name='ambiguous runtime receipt';accept=$false;value=@{passed=$true;nativeExecuted=$false;powershellVersion='5.1'}}
)) {
  $proof=[ordered]@{startupSelectionContracts=$case.value}; $accepted=$false
  try { . $receiptGuardBlock; $accepted=$true } catch { }
  Assert-Contract ($accepted -eq $case.accept) $case.name
  $script:receiptCases += [ordered]@{name=$case.name;accepted=$accepted;expectedAccepted=$case.accept;nativeExecuted=$false}
}

$script:cases = @()
function Invoke-ZentraVerificationSuite {
  param($Harness,[string]$Suite,[string[]]$ExtraArguments=@())
  $script:stubInvocations++
  Assert-Contract ($Suite -ceq 'startup_recovery::tests::' -and $ExtraArguments.Count -eq 0) 'inert stub receives fixed group only'
  if ($script:scenario.ContainsKey('throw')) { throw 'Synthetic harness rejection; no native execution.' }
  $row = [ordered]@{filter=$Suite;selectedNames=10;extraArguments=@();nativeArguments=@($Suite,'--test-threads=1');contextMode='diagnostics-verification';exit=0;durationMs=0;passed=10;failed=0;ignored=0;stdout='synthetic.log';stderr='synthetic-errors.log'}
  if ($script:scenario.ContainsKey('row')) { foreach($key in $script:scenario.row.Keys) { $row[$key]=$script:scenario.row[$key] } }
  if ($script:scenario.ContainsKey('noRow')) { return }
  $Harness.Proof.suiteExecutions += $row
  if ($script:scenario.ContainsKey('twoRows')) { $Harness.Proof.suiteExecutions += $row }
}
$testCases = @(
  @{name='valid LF';accept=$true},
  @{name='valid CRLF';accept=$true;crlf=$true},
  @{name='valid reversed catalog';accept=$true;reverse=$true},
  @{name='missing Windows tenth';accept=$false;catalog=@($expected[0..8]);preflight=$true},
  @{name='empty catalog';accept=$false;catalog=@();preflight=$true},
  @{name='eleventh unexpected test';accept=$false;catalog=@($expected)+@('startup_recovery::tests::unreviewed');preflight=$true},
  @{name='duplicate with missing name';accept=$false;catalog=@($expected[0..8])+@($expected[0]);preflight=$true},
  @{name='wrong case catalog';accept=$false;catalog=@($expected[0..8])+@($expected[9].ToUpperInvariant());preflight=$true},
  @{name='Contains neighbor replacement';accept=$false;catalog=@($expected[0..8])+@('foreign::'+$expected[9]);preflight=$true},
  @{name='native harness throw';accept=$false;throw=$true},
  @{name='stale no new row';accept=$false;noRow=$true},
  @{name='two new rows';accept=$false;twoRows=$true},
  @{name='wrong filter';accept=$false;row=@{filter='backup::'}},
  @{name='wrong context';accept=$false;row=@{contextMode='release-preflight'}},
  @{name='only nine passed';accept=$false;row=@{passed=9}},
  @{name='eleven passed';accept=$false;row=@{passed=11}},
  @{name='nonzero exit';accept=$false;row=@{exit=1}},
  @{name='failure recorded';accept=$false;row=@{failed=1}},
  @{name='ignored recorded';accept=$false;row=@{ignored=1}},
  @{name='wrong selected count';accept=$false;row=@{selectedNames=9}},
  @{name='ignored flag override';accept=$false;row=@{extraArguments=@('--ignored')}},
  @{name='wrong native arguments';accept=$false;row=@{nativeArguments=@('startup_recovery::tests::','--ignored')}},
  @{name='missing tenth named result despite 10 aggregate';accept=$false;names=@($expected[0..8])},
  @{name='duplicated named result despite 10 aggregate';accept=$false;names=@($expected[0..8])+@($expected[0])},
  @{name='foreign named result despite 10 aggregate';accept=$false;names=@($expected[0..8])+@('foreign::test')},
  @{name='named ignored despite 10 aggregate';accept=$false;namedStatus='ignored'},
  @{name='named failed despite 10 aggregate';accept=$false;namedStatus='FAILED'},
  @{name='no summary despite successful row';accept=$false;summary=''},
  @{name='wrong summary count despite successful row';accept=$false;summary='test result: ok. 9 passed; 0 failed; 0 ignored; 999 filtered out; finished in 0.01s'},
  @{name='ambiguous second summary';accept=$false;doubleSummary=$true}
)
$block = [ScriptBlock]::Create($fixtureBody)
$fixtureDirectory = Join-Path $EvidenceDirectory 'inert-libtest-fixtures'
[IO.Directory]::CreateDirectory($fixtureDirectory) | Out-Null
foreach ($case in $testCases) {
  $script:scenario=$case; $script:stubInvocations=0
  $caseDirectory = Join-Path $fixtureDirectory ('case-{0:D2}' -f ($script:cases.Count+1))
  [IO.Directory]::CreateDirectory($caseDirectory) | Out-Null
  $selected = if ($case.ContainsKey('catalog')) { @($case.catalog) } elseif($case.ContainsKey('reverse')) { @($expected[9..0]) } else { @($expected) }
  $outputNames = if ($case.ContainsKey('names')) { @($case.names) } else { @($expected) }
  $namedStatus = if ($case.ContainsKey('namedStatus')) { $case.namedStatus } else { 'ok' }
  $summary = if ($case.ContainsKey('summary')) { $case.summary } else { 'test result: ok. 10 passed; 0 failed; 0 ignored; 999 filtered out; finished in 0.01s' }
  $newline = if ($case.ContainsKey('crlf')) { "`r`n" } else { "`n" }
  $output = 'running 10 tests' + $newline + (($outputNames | ForEach-Object { 'test ' + $_ + ' ... ' + $namedStatus }) -join $newline) + $newline + $summary + $newline
  if($case.ContainsKey('doubleSummary')) { $output += $summary + $newline }
  [IO.File]::WriteAllText((Join-Path $caseDirectory 'synthetic.log'),$output,[Text.UTF8Encoding]::new($false))
  $harness=[pscustomobject]@{TestNames=$selected;Artifacts=$caseDirectory;Proof=[ordered]@{suiteExecutions=@([ordered]@{filter='earlier';passed=10})}}
  $proof=[ordered]@{}; $accepted=$false; $crashSentinel=$false; $errorType=$null
  try { . $block; $accepted=$true; $crashSentinel=$true } catch { $errorType=$_.Exception.GetType().FullName }
  Assert-Contract ($accepted -eq $case.accept) $case.name
  Assert-Contract ($crashSentinel -eq $case.accept) ($case.name + ' reaches subsequent inert sentinel only on success')
  Assert-Contract ($proof.startupRecovery.verified -eq $case.accept) ($case.name + ' cannot claim verified when refused')
  if ($case.ContainsKey('preflight')) { Assert-Contract ($script:stubInvocations -eq 0) ($case.name + ' refused before dispatch') }
  $script:cases += [ordered]@{name=$case.name;expectedAccepted=$case.accept;accepted=$accepted;stubInvocations=$script:stubInvocations;subsequentInertSentinel=$crashSentinel;verified=$proof.startupRecovery.verified;errorType=$errorType;nativeExecuted=$false}
}
$receipt = [ordered]@{powershellVersion=$PSVersionTable.PSVersion.ToString();checks=$script:checks;cases=$script:cases.Count;passedCases=$script:cases.Count;receiptCases=$script:receiptCases.Count;receiptResults=$script:receiptCases;nativeExecuted=$false;wrapperExecuted=$false;realHarnessExecuted=$false;ciFlagsFabricated=$false;prototypeOnly=$false;passed=$true;sourceWrapperSha256=(Get-FileHash -LiteralPath $WrapperPath -Algorithm SHA256).Hash.ToLowerInvariant();sourceHarnessSha256=(Get-FileHash -LiteralPath $HarnessPath -Algorithm SHA256).Hash.ToLowerInvariant();results=$script:cases}
[IO.File]::WriteAllText($resultPath,($receipt|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
Write-Host ('Startup selection contracts passed: {0}; inert cases: {1}; native execution: false' -f $script:checks,$script:cases.Count)
[pscustomobject]$receipt
