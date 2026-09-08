[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Installer execution is restricted to an isolated GitHub Windows runner.'
}
if ($env:GITHUB_REPOSITORY -ne 'leartshbj1/zentra') { throw 'Unexpected repository.' }
foreach ($name in @('ZENTRA_RELEASE_TAG', 'ZENTRA_PREVIOUS_TAG')) {
    if ([Environment]::GetEnvironmentVariable($name) -notmatch '^v\d+\.\d+\.\d+$') { throw "Invalid $name." }
}
foreach ($name in @('ZENTRA_CURRENT_SHA256', 'ZENTRA_CURRENT_EXE_SHA256', 'ZENTRA_PREVIOUS_SHA256')) {
    if ([Environment]::GetEnvironmentVariable($name) -notmatch '^[a-fA-F0-9]{64}$') { throw "Invalid $name." }
}
if ($env:ZENTRA_NATIVE_SOURCE -notmatch '^[a-f0-9]{40}$') { throw 'Invalid native source.' }
if ($env:ZENTRA_AUDIT_MODE -notin @('fresh', 'upgrade')) { throw 'Invalid audit mode.' }
$version = $env:ZENTRA_RELEASE_TAG.Substring(1)
$previous = $env:ZENTRA_PREVIOUS_TAG.Substring(1)
if ([version]$version -le [version]$previous) { throw 'The current installer must be newer.' }
& git cat-file -e "$($env:ZENTRA_NATIVE_SOURCE)^{commit}"
if ($LASTEXITCODE -ne 0) { throw 'Native source does not exist.' }
& git diff --exit-code $env:ZENTRA_NATIVE_SOURCE HEAD -- desktop pnpm-lock.yaml pnpm-workspace.yaml
if ($LASTEXITCODE -ne 0) { throw 'Audit checkout differs from the packaged native source.' }
if (Get-Process -Name Zentra -ErrorAction SilentlyContinue) { throw 'Runner already has an application process.' }

$auditRoot = Join-Path $env:RUNNER_TEMP "zentra-installer-$($env:GITHUB_RUN_ID)-$($env:ZENTRA_AUDIT_MODE)"
if (Test-Path -LiteralPath $auditRoot) { throw 'Refusing to reuse an existing runner profile.' }
$downloads = Join-Path $auditRoot 'downloads'
$installRoot = Join-Path $auditRoot 'application'
$profile = Join-Path $auditRoot 'profile'
$webview = Join-Path $auditRoot 'webview'
$outputRoot = Join-Path $env:GITHUB_WORKSPACE 'outputs/windows-installer-audit'
New-Item -ItemType Directory -Path $downloads,$profile,$webview,$outputRoot -Force | Out-Null
$verifier = Join-Path $env:GITHUB_WORKSPACE 'scripts/verify-windows-release-profile.py'

function Get-Installer([string]$Tag, [string]$Hash) {
    $name = "Zentra_$($Tag.Substring(1))_x64-setup.exe"
    $path = Join-Path $downloads $name
    if ($Tag -eq $env:ZENTRA_RELEASE_TAG) {
        # A read-only Actions token cannot retrieve a draft release. Use only
        # the immutable, hash-pinned artifact in the existing release bucket;
        # the public updater manifest is not promoted by this workflow.
        $origin = 'https://xvfohjdlhlirksrvkiqu.supabase.co/storage/v1/object/public/zentra-releases'
        Invoke-WebRequest -Uri "$origin/$name" -OutFile $path
    } else {
        & gh release download $Tag --repo $env:GITHUB_REPOSITORY --pattern $name --dir $downloads
        if ($LASTEXITCODE -ne 0) { throw "Installer download failed for $Tag." }
    }
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $Hash) { throw 'Installer hash mismatch.' }
    return $path
}

function Install-ExactPackage([string]$Path, [string]$ExpectedVersion) {
    $installer = Start-Process -FilePath $Path -ArgumentList @('/S', "/D=$installRoot") -WindowStyle Hidden -PassThru
    if (-not $installer.WaitForExit(180000)) { throw 'Installer did not exit within three minutes.' }
    if ($installer.ExitCode -ne 0) { throw "Installer returned $($installer.ExitCode)." }
    $installed = Join-Path $installRoot 'Zentra.exe'
    if (-not (Test-Path -LiteralPath $installed)) { throw 'Installed executable is missing.' }
    if ((Get-Item -LiteralPath $installed).VersionInfo.ProductVersion -ne $ExpectedVersion) { throw 'Installed product version mismatch.' }
    return $installed
}

function Start-AndVerify([string]$Exe, [string]$ExpectedVersion, [switch]$Upgraded) {
    $env:HELVICHANTIER_DATA_DIR = $profile
    $env:WEBVIEW2_USER_DATA_FOLDER = $webview
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--disable-gpu'
    try {
        $owned = Start-Process -FilePath $Exe -WindowStyle Hidden -PassThru
        $ownedStartedAt = $owned.StartTime
        $deadline = [DateTime]::UtcNow.AddSeconds(90)
        $ready = $false
        while ([DateTime]::UtcNow -lt $deadline) {
            $owned.Refresh()
            if ($owned.HasExited) { throw "Packaged app exited before database initialization ($($owned.ExitCode))." }
            $probe = & python $verifier probe $profile $ExpectedVersion 2>$null
            if ($LASTEXITCODE -eq 0) { $ready = $true; break }
            Start-Sleep -Milliseconds 500
        }
        if (-not $ready) { throw 'Packaged app did not initialize its isolated profile.' }
        Start-Sleep -Seconds 5
        $owned.Refresh()
        if ($owned.HasExited) { throw 'Packaged app terminated after initialization.' }
        if ($Upgraded) {
            $verification = & python $verifier verify $profile $ExpectedVersion
            if ($LASTEXITCODE -ne 0) { throw 'Existing data or installation identity changed during upgrade.' }
        }
        $result = $probe | ConvertFrom-Json
        if ($Upgraded) { $result | Add-Member -NotePropertyName preservation -NotePropertyValue ($verification | ConvertFrom-Json) }
        return $result
    } finally {
        if ($null -ne (Get-Variable -Name owned -ErrorAction SilentlyContinue)) {
            $running = Get-Process -Id $owned.Id -ErrorAction SilentlyContinue
            if ($running -and $running.Path -eq $Exe -and $running.StartTime -eq $ownedStartedAt) {
                Stop-Process -Id $owned.Id
                Wait-Process -Id $owned.Id -Timeout 15 -ErrorAction SilentlyContinue
            }
        }
        Remove-Item Env:HELVICHANTIER_DATA_DIR,Env:WEBVIEW2_USER_DATA_FOLDER,Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
    }
}

$currentInstaller = Get-Installer $env:ZENTRA_RELEASE_TAG $env:ZENTRA_CURRENT_SHA256
$previousProbe = $null
if ($env:ZENTRA_AUDIT_MODE -eq 'upgrade') {
    $previousInstaller = Get-Installer $env:ZENTRA_PREVIOUS_TAG $env:ZENTRA_PREVIOUS_SHA256
    $previousExe = Install-ExactPackage $previousInstaller $previous
    $previousProbe = Start-AndVerify $previousExe $previous
    & python $verifier seed $profile $previous
    if ($LASTEXITCODE -ne 0) { throw 'Failed to prepare fictional upgrade data.' }
}
$currentExe = Install-ExactPackage $currentInstaller $version
$installedHash = (Get-FileHash -LiteralPath $currentExe -Algorithm SHA256).Hash
if ($installedHash -ne $env:ZENTRA_CURRENT_EXE_SHA256) { throw 'Installed executable differs from verified NSIS payload.' }
$currentProbe = Start-AndVerify $currentExe $version -Upgraded:($env:ZENTRA_AUDIT_MODE -eq 'upgrade')
$restartProbe = Start-AndVerify $currentExe $version -Upgraded:($env:ZENTRA_AUDIT_MODE -eq 'upgrade')
$proof = [ordered]@{
    mode = $env:ZENTRA_AUDIT_MODE
    version = $version
    previousVersion = $previous
    source = $env:ZENTRA_NATIVE_SOURCE
    workflow = $env:GITHUB_RUN_ID
    installerSha256 = $env:ZENTRA_CURRENT_SHA256.ToLowerInvariant()
    installedExeSha256 = $installedHash.ToLowerInvariant()
    installerExecuted = $true
    packagedApplicationStarted = $true
    packagedApplicationRestarted = $true
    isolatedWindowsRunner = $true
    previousProfile = $previousProbe
    currentProfile = $currentProbe
    restartedProfile = $restartProbe
    scope = 'Exact NSIS installation, packaged app startup and SQLite/identity preservation; no interactive UI, Authenticode or physical-device claim.'
}
$proof | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $outputRoot "$($env:ZENTRA_AUDIT_MODE)-report.json")
Write-Output ($proof | ConvertTo-Json -Depth 8 -Compress)
