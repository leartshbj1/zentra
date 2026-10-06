[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$appSource = '0d2571a741883add178b485e8a1ad4d0222d4204'
$buildPipeline = '4a44c762a4c39c5f625519d1b52cef6391587249'
$verifierRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$appRoot = Join-Path $verifierRoot '.zentra-windows-source'

function Invoke-SmokeGit {
    param([string[]]$Arguments)
    $lines = @(& git @Arguments)
    if ($LASTEXITCODE -ne 0) { throw 'Smoke Git provenance check failed.' }
    return $lines
}
function Assert-SmokeEnvironment {
    param($Environment)
    if ($Environment.CIRCLECI -cne 'true' -or $Environment.OS -cne 'Windows_NT' -or
        $Environment.CIRCLE_BRANCH -cne 'codex/release-1.90.15-smoke-windows-20261006' -or
        $Environment.CIRCLE_JOB -cne 'windows-package-smoke-1915' -or
        $Environment.CIRCLE_BUILD_NUM -cnotmatch '^[1-9][0-9]*$' -or
        $Environment.CIRCLE_SHA1 -cnotmatch '^[0-9a-f]{40}$' -or
        $Environment.CIRCLE_SHA1 -ceq $appSource -or $Environment.CIRCLE_SHA1 -ceq $buildPipeline -or
        $Environment.ZENTRA_SMOKE_JOB -cne '281' -or $Environment.ZENTRA_SMOKE_SOURCE -cne $appSource -or
        $Environment.ZENTRA_SMOKE_PIPELINE_SOURCE -cne $buildPipeline -or $Environment.ZENTRA_SMOKE_VERSION -cne '1.90.15') {
        throw 'The exact opt-in Windows smoke, frozen source and real distinct verifier are required.'
    }
}
function Assert-SmokeApplication {
    $head = @(Invoke-SmokeGit @('-C',$appRoot,'rev-parse','HEAD'))
    if ($head.Count -ne 1 -or $head[0] -cne $appSource) { throw 'Frozen Windows reference source differs.' }
    $branch = @(& git -C $appRoot symbolic-ref --quiet HEAD)
    if ($LASTEXITCODE -ne 1 -or $branch.Count) { throw 'Frozen application reference must be detached.' }
    if (@(Invoke-SmokeGit @('-C',$appRoot,'diff','--name-only','HEAD')).Count) { throw 'Frozen application reference changed.' }
    foreach ($relative in @('desktop/package.json','desktop/src-tauri/tauri.conf.json')) {
        if ((Get-Content -LiteralPath (Join-Path $appRoot $relative) -Raw | ConvertFrom-Json).version -cne '1.90.15') { throw 'Frozen Windows JSON version differs.' }
    }
    foreach ($item in @(@('desktop/src-tauri/Cargo.toml','\[package\]'),@('desktop/src-tauri/Cargo.lock','\[\[package\]\]'))) {
        $text = Get-Content -LiteralPath (Join-Path $appRoot $item[0]) -Raw
        $matches = [regex]::Matches($text,$item[1]+'\r?\nname = "helvichantier"\r?\nversion = "([^"]+)"')
        if ($matches.Count -ne 1 -or $matches[0].Groups[1].Value -cne '1.90.15') { throw 'Frozen Windows Rust version differs.' }
    }
}

$environment = @{}
foreach ($name in @('CIRCLECI','OS','CIRCLE_BRANCH','CIRCLE_JOB','CIRCLE_BUILD_NUM','CIRCLE_SHA1','ZENTRA_SMOKE_JOB','ZENTRA_SMOKE_SOURCE','ZENTRA_SMOKE_PIPELINE_SOURCE','ZENTRA_SMOKE_VERSION')) {
    $environment[$name] = [Environment]::GetEnvironmentVariable($name,'Process')
}
Assert-SmokeEnvironment $environment
$head = @(Invoke-SmokeGit @('-C',$verifierRoot,'rev-parse','HEAD'))
if ($head.Count -ne 1 -or $head[0] -cne $env:CIRCLE_SHA1) { throw 'Smoke checkout differs from actual verifier.' }
& git -C $verifierRoot cat-file -e "$appSource^{commit}"
if ($LASTEXITCODE -ne 0) { Invoke-SmokeGit @('-C',$verifierRoot,'fetch','--depth','1','origin',$appSource) | Out-Host }
$allowed = @('.circleci/config.yml','.circleci/windows-smoke1915-controller.ps1','.circleci/smoke-windows-1915.py','.circleci/windows_smoke_contract.py','.circleci/verify-1915-windows-input.py')
$changes = @(Invoke-SmokeGit @('-C',$verifierRoot,'diff','--name-only',$appSource,$env:CIRCLE_SHA1))
if ($changes.Count -ne $allowed.Count -or @($changes | Where-Object { $_ -cnotin $allowed }).Count) { throw 'Smoke verifier changes unexpected files.' }
if (@(Invoke-SmokeGit @('-C',$verifierRoot,'status','--porcelain','--untracked-files=all','--','.circleci')).Count) { throw 'Smoke CI controls are modified.' }
if (Test-Path -LiteralPath $appRoot) { throw 'Refusing inherited application reference.' }
Invoke-SmokeGit @('init',$appRoot) | Out-Host
Invoke-SmokeGit @('-C',$appRoot,'remote','add','origin','https://github.com/leartshbj1/zentra.git') | Out-Host
Invoke-SmokeGit @('-C',$appRoot,'fetch','--depth','1','origin',$appSource) | Out-Host
Invoke-SmokeGit @('-C',$appRoot,'checkout','--detach','FETCH_HEAD') | Out-Host
Assert-SmokeApplication
Set-Location $verifierRoot
# The copied helpers validate the frozen product bytes at the verifier checkout,
# which is proven to differ from the isolated application solely under .circleci.
& python .circleci/verify-1915-windows-input.py
if ($LASTEXITCODE -ne 0) { throw 'Exact successful Windows 281 build inputs rejected.' }
& python .circleci/smoke-windows-1915.py windows $env:ZENTRA_SMOKE_JOB $env:ZENTRA_SMOKE_SOURCE --pipeline-source $env:ZENTRA_SMOKE_PIPELINE_SOURCE
if ($LASTEXITCODE -ne 0) { throw 'Windows 1.90.15 packaged smoke failed.' }
Assert-SmokeApplication
