param(
    [Parameter(Mandatory)][ValidateRange(1, 2147483647)][int]$Job,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Source
)

$ErrorActionPreference = 'Stop'
$smokeBuildDeadline = [DateTimeOffset]::UtcNow.AddMinutes(10)
$smokeBuildReady = $false

while ([DateTimeOffset]::UtcNow -lt $smokeBuildDeadline) {
    $smokeRemainingSeconds = [int][Math]::Ceiling(($smokeBuildDeadline - [DateTimeOffset]::UtcNow).TotalSeconds)
    if ($smokeRemainingSeconds -le 0) { break }
    $smokeRequestTimeout = [Math]::Min(30, $smokeRemainingSeconds)
    $smokeBuild = Invoke-RestMethod -Uri "https://circleci.com/api/v1.1/project/github/leartshbj1/zentra/$Job" -Headers @{Accept='application/json'} -TimeoutSec $smokeRequestTimeout
    if ($smokeBuild.vcs_revision -cne $Source) { throw 'Windows build source differs from the pinned application source.' }
    if ($smokeBuild.status -in @('failed', 'canceled')) { throw "Windows build $Job ended with status $($smokeBuild.status)." }
    if ($smokeBuild.status -eq 'success') { $smokeBuildReady = $true; break }
    Write-Output "Waiting for Windows build ${Job}: $($smokeBuild.status)"
    $smokeRemainingMilliseconds = [Math]::Max(0, [Math]::Floor(($smokeBuildDeadline - [DateTimeOffset]::UtcNow).TotalMilliseconds))
    if ($smokeRemainingMilliseconds -le 0) { break }
    Start-Sleep -Milliseconds ([int][Math]::Min(45000, $smokeRemainingMilliseconds))
}

if (-not $smokeBuildReady) { throw "Windows build $Job did not succeed within the ten-minute wait." }
& python desktop/scripts/cloud-package-smoke.py windows $Job $Source
if ($LASTEXITCODE -ne 0) { throw "Windows package smoke exited with code $LASTEXITCODE." }
