param(
  [string]$HelperPath='',
  [Parameter(Mandatory=$true)][string]$ProofDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if ([string]::IsNullOrWhiteSpace($HelperPath)) { $HelperPath=Join-Path $PSScriptRoot 'recovery-source-integrity.ps1' }
. ([ScriptBlock]::Create([IO.File]::ReadAllText($HelperPath)))
# Real Git and ordinary text/JSON fixtures only. No CI flags are fabricated and
# no cargo, Rust, native harness, application, reset, restore or cleanup is run.
if (Test-Path -LiteralPath $ProofDirectory) { throw 'Use a new proof directory; all inert fixtures and evidence are retained.' }
[IO.Directory]::CreateDirectory($ProofDirectory) | Out-Null
$script:results=@()
$script:unicodeInput='desktop/src-tauri/src/source ;# ' + [char]0x00e9 + '.rs'
function Assert-SourceContract {
  param([bool]$Condition,[string]$Name)
  if (-not $Condition) { throw ('Source integrity contract failed: ' + $Name) }
  $script:results += [pscustomobject]@{name=$Name;passed=$true}
}
function Write-FixtureFile {
  param([string]$Root,[string]$Relative,[string]$Text)
  $path=Join-Path $Root $Relative
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
  [IO.File]::WriteAllText($path,$Text,[Text.UTF8Encoding]::new($false))
}
function Invoke-FixtureGit {
  param([string]$Root,[string[]]$Arguments)
  & git -C $Root @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Inert fixture Git operation failed.' }
}
function New-InertSourceFixture {
  param([string]$Name)
  $root=Join-Path $ProofDirectory ('inert Git fixtures/' + $Name)
  [IO.Directory]::CreateDirectory($root) | Out-Null
  Invoke-FixtureGit $root @('-c','init.templateDir=','init','--quiet')
  Invoke-FixtureGit $root @('config','user.name','Synthetic source contract')
  Invoke-FixtureGit $root @('config','user.email','source-contract@example.test')
  Invoke-FixtureGit $root @('config','core.autocrlf','false')
  $hooks=Join-Path $root '.git/empty-hooks'
  [IO.Directory]::CreateDirectory($hooks) | Out-Null
  Invoke-FixtureGit $root @('config','core.hooksPath',$hooks)
  Write-FixtureFile $root '.gitignore' "/desktop/artifacts/`n/desktop/src-tauri/target/`n"
  Write-FixtureFile $root 'desktop/src-tauri/src/lib.rs' 'inert Rust text, never compiled'
  Write-FixtureFile $root 'desktop/src-tauri/Cargo.toml' 'inert Cargo text, never consumed'
  Write-FixtureFile $root 'desktop/src-tauri/tauri.conf.json' '{"fixture":true}'
  Write-FixtureFile $root 'desktop/scripts/verify-native-recovery.ps1' 'inert wrapper text, never executed'
  Write-FixtureFile $root '.circleci/config.yml' 'inert config text, never dispatched'
  Write-FixtureFile $root 'README.md' 'immutable unrelated input'
  Write-FixtureFile $root $script:unicodeInput 'inert spaced Unicode input'
  foreach ($generated in $script:ZentraRecoveryGeneratedOutputs) { Write-FixtureFile $root $generated '{"fixture":"before"}' }
  Invoke-FixtureGit $root @('add','--all')
  Invoke-FixtureGit $root @('-c','commit.gpgsign=false','commit','--quiet','-m','inert exact-source fixture')
  $source=(Invoke-ZentraRecoveryGit $root 'rev-parse HEAD').Trim()
  return [pscustomobject]@{root=$root;source=$source;evidence=(Join-Path $root 'desktop/artifacts/recovery-source-integrity')}
}
function Test-AfterMutation {
  param([string]$Name,[scriptblock]$Mutation,[bool]$Admitted=$false,[string]$Reason='')
  $fixture=New-InertSourceFixture $Name
  $snapshot=New-ZentraRecoverySourceSnapshot $fixture.root $fixture.source $fixture.evidence
  & $Mutation $fixture
  $threw=$false
  try { Assert-ZentraRecoverySourceSnapshot $fixture.root $fixture.source $snapshot.path $snapshot.sha256 $fixture.evidence 'after-build' } catch { $threw=$true }
  $report=[IO.File]::ReadAllText((Join-Path $fixture.evidence 'after-build.json'),[Text.Encoding]::UTF8) | ConvertFrom-Json
  Assert-SourceContract ($threw -ne $Admitted -and $report.passed -eq $Admitted) $Name
  Assert-SourceContract ($null -ne $report.source -and @($report.source.files).Count -gt 0 -and $report.source.indexSha256.Length -eq 64) ($Name + ': complete status and hashes retained')
  if ($Reason.Length -gt 0) { Assert-SourceContract (($report.errors -join "`n").Contains($Reason)) ($Name + ': exact refusal reason retained') }
  return [pscustomobject]@{fixture=$fixture;snapshot=$snapshot;report=$report}
}
function Test-BeforeMutation {
  param([string]$Name,[scriptblock]$Mutation,[bool]$WrongSource=$false)
  $fixture=New-InertSourceFixture $Name
  & $Mutation $fixture
  $source=$fixture.source
  if ($WrongSource) { $source='1111111111111111111111111111111111111111' }
  $threw=$false
  try { $null=New-ZentraRecoverySourceSnapshot $fixture.root $source $fixture.evidence } catch { $threw=$true }
  $report=[IO.File]::ReadAllText((Join-Path $fixture.evidence 'before-build.json'),[Text.Encoding]::UTF8) | ConvertFrom-Json
  Assert-SourceContract ($threw -and -not $report.passed -and @($report.errors).Count -gt 0) $Name
  Assert-SourceContract ($null -ne $report.source -and @($report.source.files).Count -gt 0) ($Name + ': pre-build refusal evidence retained')
}

try {
  $clean=Test-AfterMutation 'clean-build' { param($f); Write-FixtureFile $f.root 'desktop/src-tauri/target/inert-build-output.txt' 'ignored build output' } $true
  Assert-SourceContract (@($clean.report.source.status).Count -eq 0) 'ignored output is not an input exception'
  $generated=Test-AfterMutation 'four-generated-json-outputs' { param($f); foreach($path in $script:ZentraRecoveryGeneratedOutputs){Write-FixtureFile $f.root $path '{"fixture":"after"}'} } $true
  Assert-SourceContract (@($generated.report.generatedDifferences).Count -eq 4 -and @($generated.report.source.status).Count -eq 4) 'all four generated outputs admitted with separate before/after hashes'
  $generatedDiff=Get-Content -Raw -LiteralPath (Join-Path $generated.fixture.evidence 'after-build-generated.patch')
  Assert-SourceContract ($generatedDiff.Contains('acl-manifests.json') -and $generatedDiff.Contains('capabilities.json') -and $generatedDiff.Contains('desktop-schema.json') -and $generatedDiff.Contains('windows-schema.json')) 'actual generated Git difference retained'
  foreach($input in @('desktop/src-tauri/src/lib.rs','desktop/src-tauri/Cargo.toml','desktop/src-tauri/tauri.conf.json','desktop/scripts/verify-native-recovery.ps1','.circleci/config.yml','README.md',$script:unicodeInput)) {
    $relative=$input
    $mutation={param($f);Write-FixtureFile $f.root $relative 'mutated immutable input'}.GetNewClosure()
    $null=Test-AfterMutation ('immutable-' + ($input -replace '[^a-zA-Z0-9]','-')) $mutation $false 'Immutable input hash changed'
  }
  $null=Test-AfterMutation 'untracked-input' {param($f);Write-FixtureFile $f.root 'new-script.ps1' 'inert untracked input'} $false 'Unauthorized Git change: ??'
  $null=Test-AfterMutation 'untracked-other-generated-json' {param($f);Write-FixtureFile $f.root 'desktop/src-tauri/gen/schemas/extra.json' '{}'} $false 'Unauthorized Git change: ??'
  $null=Test-AfterMutation 'staged-native-input' {param($f);Write-FixtureFile $f.root 'desktop/src-tauri/src/lib.rs' 'staged mutation';Invoke-FixtureGit $f.root @('add','desktop/src-tauri/src/lib.rs')} $false 'tracked index'
  $null=Test-AfterMutation 'staged-allowed-json' {param($f);Write-FixtureFile $f.root $script:ZentraRecoveryGeneratedOutputs[0] '{"staged":true}';Invoke-FixtureGit $f.root @('add',$script:ZentraRecoveryGeneratedOutputs[0])} $false 'Unauthorized Git change: M '
  $null=Test-AfterMutation 'deleted-allowed-output' {param($f);Remove-Item -LiteralPath (Join-Path $f.root $script:ZentraRecoveryGeneratedOutputs[0])} $false 'Tracked input validation failed'
  $null=Test-AfterMutation 'renamed-allowed-output' {param($f);Invoke-FixtureGit $f.root @('mv',$script:ZentraRecoveryGeneratedOutputs[0],'desktop/src-tauri/gen/schemas/renamed.json')} $false 'Unauthorized Git change: R '
  $null=Test-AfterMutation 'invalid-allowed-json' {param($f);Write-FixtureFile $f.root $script:ZentraRecoveryGeneratedOutputs[0] '{invalid JSON'} $false 'Tracked input validation failed'
  $null=Test-AfterMutation 'allowed-output-is-directory' {param($f);$path=Join-Path $f.root $script:ZentraRecoveryGeneratedOutputs[0];Remove-Item -LiteralPath $path;[IO.Directory]::CreateDirectory($path)|Out-Null} $false 'ordinary file'
  $null=Test-AfterMutation 'generated-parent-reparse' {
    param($f)
    $schemas=Join-Path $f.root 'desktop/src-tauri/gen/schemas'
    $destination=Join-Path $f.root 'desktop/artifacts/moved-inert-schemas'
    $fullSchemas=[IO.Path]::GetFullPath($schemas);$fullDestination=[IO.Path]::GetFullPath($destination)
    $prefix=[IO.Path]::GetFullPath($f.root)+[IO.Path]::DirectorySeparatorChar
    if(-not $fullSchemas.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)-or -not $fullDestination.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture move escaped retained workspace.'}
    Move-Item -LiteralPath $schemas -Destination $destination
    New-Item -ItemType Junction -Path $schemas -Target $destination | Out-Null
  } $false 'Reparse input or ancestor refused'
  $hidden=Test-AfterMutation 'hidden-native-modification' {param($f);Invoke-FixtureGit $f.root @('update-index','--assume-unchanged','desktop/src-tauri/src/lib.rs');Write-FixtureFile $f.root 'desktop/src-tauri/src/lib.rs' 'hidden native mutation'} $false 'Immutable input hash changed'
  Assert-SourceContract (@($hidden.report.source.status).Count -eq 0) 'immutable hashing refuses native mutation hidden from real Git status'
  $null=Test-AfterMutation 'head-changed' {param($f);Write-FixtureFile $f.root 'README.md' 'new committed source';Invoke-FixtureGit $f.root @('add','README.md');Invoke-FixtureGit $f.root @('-c','commit.gpgsign=false','commit','--quiet','-m','inert changed HEAD')} $false 'Repository HEAD changed'
  $null=Test-AfterMutation 'snapshot-tampered' {param($f);[IO.File]::AppendAllText((Join-Path $f.evidence 'before-build.json'),"`n ")} $false 'snapshot hash changed'
  Test-BeforeMutation 'pre-build-native-dirty' {param($f);Write-FixtureFile $f.root 'desktop/src-tauri/src/lib.rs' 'dirty before build'}
  Test-BeforeMutation 'pre-build-generated-dirty' {param($f);Write-FixtureFile $f.root $script:ZentraRecoveryGeneratedOutputs[0] '{"dirtyBeforeBuild":true}'}
  Test-BeforeMutation 'pre-build-untracked' {param($f);Write-FixtureFile $f.root 'new-input.txt' 'untracked before build'}
  Test-BeforeMutation 'pre-build-staged' {param($f);Write-FixtureFile $f.root 'README.md' 'staged before build';Invoke-FixtureGit $f.root @('add','README.md')}
  Test-BeforeMutation 'pre-build-hidden-native' {param($f);Invoke-FixtureGit $f.root @('update-index','--assume-unchanged','desktop/src-tauri/src/lib.rs');Write-FixtureFile $f.root 'desktop/src-tauri/src/lib.rs' 'hidden before build'}
  Test-BeforeMutation 'pre-build-wrong-head' {param($f)} $true
  $beforeHash=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $clean.fixture.evidence 'after-build.json')).Hash
  $threw=$false
  try { Assert-ZentraRecoverySourceSnapshot $clean.fixture.root $clean.fixture.source $clean.snapshot.path $clean.snapshot.sha256 $clean.fixture.evidence 'after-build' } catch {$threw=$true}
  Assert-SourceContract ($threw -and (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $clean.fixture.evidence 'after-build.json')).Hash -ceq $beforeHash) 'existing evidence refused without overwrite'
  $localRefused=$false
  try { Assert-ZentraRecoverySourceCi $clean.fixture.source } catch {$localRefused=$true}
  Assert-SourceContract $localRefused 'actual workstation environment stays refused without fabricated CI flags'
  $race=New-InertSourceFixture 'snapshot-modified-during-real-scan'
  $raceSnapshot=New-ZentraRecoverySourceSnapshot $race.root $race.source $race.evidence
  $script:raceSnapshotPath=$raceSnapshot.path
  $script:raceScanner=${function:Get-ZentraRecoverySourceState}
  $script:raceAttempted=$false;$script:raceMutationBlocked=$false;$script:raceMutationSucceeded=$false;$script:raceObservedState=$null
  function Get-ZentraRecoverySourceState {
    param([string]$Repository)
    $actual=& $script:raceScanner $Repository
    $script:raceObservedState=$actual
    $script:raceAttempted=$true
    try { [IO.File]::AppendAllText($script:raceSnapshotPath,"`n ");$script:raceMutationSucceeded=$true }
    catch { $script:raceMutationBlocked=$true;throw }
    return $actual
  }
  $raceRefused=$false
  try { Assert-ZentraRecoverySourceSnapshot $race.root $race.source $raceSnapshot.path $raceSnapshot.sha256 $race.evidence 'after-racing-scan' }
  catch {$raceRefused=$true}
  finally { Set-Item -LiteralPath Function:Get-ZentraRecoverySourceState -Value $script:raceScanner }
  $raceReport=[IO.File]::ReadAllText((Join-Path $race.evidence 'after-racing-scan.json'),[Text.Encoding]::UTF8)|ConvertFrom-Json
  $raceAfterHash=(Get-FileHash -Algorithm SHA256 -LiteralPath $raceSnapshot.path).Hash.ToLowerInvariant()
  $raceResult=[ordered]@{attempted=$script:raceAttempted;mutationBlocked=$script:raceMutationBlocked;mutationSucceeded=$script:raceMutationSucceeded;helperRefused=$raceRefused;reportPassed=$raceReport.passed;beforeSha256=$raceSnapshot.sha256;afterSha256=$raceAfterHash;actualGitStatusCount=@($script:raceObservedState.status).Count;actualTrackedInputs=@($script:raceObservedState.files).Count;gitResultsFabricated=$false;nativeExecuted=$false}
  [IO.File]::WriteAllText((Join-Path $ProofDirectory 'snapshot-race-result.json'),($raceResult|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
  Assert-SourceContract ($raceRefused -and -not $raceReport.passed) 'snapshot alteration during real scan cannot be admitted with stale initial hash'
  Assert-SourceContract ($script:raceAttempted -and @($script:raceObservedState.files).Count -gt 0) 'snapshot race uses the actual scanner and real Git inputs'
  Assert-SourceContract ($script:raceMutationBlocked -and -not $script:raceMutationSucceeded -and $raceAfterHash -ceq $raceSnapshot.sha256) 'snapshot write/delete sharing stays closed during integrity capture'
  Assert-SourceContract ($raceReport.actualSnapshotSha256 -ceq $raceSnapshot.sha256 -and $raceReport.finalSnapshotSha256 -ceq $raceSnapshot.sha256 -and $null -ne $raceReport.snapshotIdentityBefore -and $null -ne $raceReport.snapshotIdentityAfter) 'same captured snapshot bytes and final physical identity/hash retained'
  $status='passed'
} catch { $status='failed';$failure=[string]$_;throw }
finally {
  $summary=[ordered]@{status=$status;contractsPassed=$script:results.Count;results=$script:results;nativeExecuted=$false;cargoExecuted=$false;ciFlagsFabricated=$false;gitFixturesRetained=$true;finishedAt=[DateTimeOffset]::UtcNow.ToString('o')}
  if($status -ceq 'failed'){$summary.failure=$failure}
  [IO.File]::WriteAllText((Join-Path $ProofDirectory 'contracts.json'),($summary|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
}
Write-Output ('Recovery source integrity: ' + $script:results.Count + ' real Git/pure contracts passed; no native execution or cleanup.')
