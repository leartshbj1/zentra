# Wraps the released Zentra.exe in an unsigned MSIX for the Microsoft Store.
# The Store re-signs the package after certification, which is what removes
# the SmartScreen warning for Store installs. This file is never offered as a
# direct download: an unsigned MSIX does not install outside the Store.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [string]$IdentityFile = (Join-Path $PSScriptRoot '../msix/store-identity.json'),
    [string]$MakeAppx
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$desktop = Split-Path -Parent $PSScriptRoot
$template = Join-Path $desktop 'msix/AppxManifest.template.xml'
$icons = Join-Path $desktop 'src-tauri/icons'

if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "MSIX: missing executable $Executable" }
# The Store requires four numeric parts with the revision left at 0.
if ($Version -notmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}$') { throw "MSIX: version must be major.minor.patch, got '$Version'" }
$packageVersion = "$Version.0"

$identity = Get-Content -LiteralPath $IdentityFile -Raw | ConvertFrom-Json
$values = @($identity.identityName, $identity.publisher, $identity.publisherDisplayName)
$configured = @($values | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count
if ($configured -ne 0 -and $configured -ne 3) { throw 'MSIX: store-identity.json needs all three values or none.' }
$preview = $configured -eq 0
if ($preview) {
    $identityName = 'Zentra.Preview'
    $publisher = 'CN=Zentra Preview'
    $publisherDisplayName = 'Zentra'
} else {
    $identityName = $identity.identityName.Trim()
    $publisher = $identity.publisher.Trim()
    $publisherDisplayName = $identity.publisherDisplayName.Trim()
    if ($identityName -notmatch '^[A-Za-z0-9.\-]{3,50}$') { throw "MSIX: invalid identity name '$identityName'" }
    if ($publisher -notmatch '^CN=') { throw "MSIX: publisher must be the CN=... value from Partner Center" }
}

if (-not $MakeAppx) {
    $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
    $MakeAppx = Get-ChildItem -LiteralPath $kits -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^10\.' } |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { Join-Path $_.FullName 'x64/makeappx.exe' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
    if (-not $MakeAppx) { throw 'MSIX: makeappx.exe was not found in the Windows 10/11 SDK.' }
}

$staging = Join-Path ([IO.Path]::GetTempPath()) ("zentra-msix-" + [guid]::NewGuid().ToString('N'))
try {
    $assets = Join-Path $staging 'Assets'
    New-Item -ItemType Directory -Path $assets -Force | Out-Null
    Copy-Item -LiteralPath $Executable -Destination (Join-Path $staging 'Zentra.exe')
    foreach ($name in @('StoreLogo.png', 'Square44x44Logo.png', 'Square150x150Logo.png')) {
        Copy-Item -LiteralPath (Join-Path $icons $name) -Destination (Join-Path $assets $name)
    }

    # Kept ASCII so Windows PowerShell 5.1 reads this script without a BOM.
    $description = 'Gestion d' + [char]0x2019 + 'entreprise multisectorielle, locale et suisse'
    $manifest = Get-Content -LiteralPath $template -Raw -Encoding UTF8
    $fill = [ordered]@{
        '{{IDENTITY_NAME}}' = $identityName
        '{{PUBLISHER}}' = $publisher
        '{{PUBLISHER_DISPLAY_NAME}}' = $publisherDisplayName
        '{{VERSION}}' = $packageVersion
        '{{DESCRIPTION}}' = $description
    }
    foreach ($key in $fill.Keys) {
        $manifest = $manifest.Replace($key, [Security.SecurityElement]::Escape($fill[$key]))
    }
    if ($manifest -match '\{\{[A-Z_]+\}\}') { throw 'MSIX: a manifest placeholder was left unfilled.' }
    [xml]$manifest | Out-Null
    [IO.File]::WriteAllText((Join-Path $staging 'AppxManifest.xml'), $manifest, [Text.UTF8Encoding]::new($false))

    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    $suffix = if ($preview) { 'store-preview' } else { 'store' }
    $package = Join-Path (Resolve-Path -LiteralPath $OutputDirectory) "Zentra_${Version}_x64-$suffix.msix"
    # makeappx validates the manifest against the Windows schemas while packing.
    & $MakeAppx pack /o /h SHA256 /d $staging /p $package | Write-Host
    if ($LASTEXITCODE -ne 0) { throw "MSIX: makeappx failed with exit code $LASTEXITCODE" }
} finally {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}

[ordered]@{
    name = Split-Path -Leaf $package
    path = $package
    size = (Get-Item -LiteralPath $package).Length
    sha256 = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()
    identityName = $identityName
    publisher = $publisher
    packageVersion = $packageVersion
    storeReady = -not $preview
}
