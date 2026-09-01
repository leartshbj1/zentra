[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'updater-release-provenance.ps1')

function Remove-ZentraExactBuildArtifact {
    param(
        [Parameter(Mandatory = $true)] [string] $Path,
        [Parameter(Mandatory = $true)] [string] $ReleaseRoot
    )

    $candidate = [IO.Path]::GetFullPath($Path)
    $rootPrefix = [IO.Path]::GetFullPath($ReleaseRoot).TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Nettoyage refusé hors du dossier de build canonique : $candidate"
    }
    if (Test-Path -LiteralPath $candidate) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "Nettoyage refusé pour un chemin qui n’est pas un fichier : $candidate"
        }
        Remove-Item -LiteralPath $candidate -Force
    }
}

$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$package = Get-Content -Raw -LiteralPath (Join-Path $desktopRoot 'package.json') | ConvertFrom-Json
$tauriConfig = Get-Content -Raw -LiteralPath (Join-Path $desktopRoot 'src-tauri\tauri.conf.json') | ConvertFrom-Json
$version = [string]$package.version
if ($tauriConfig.version -ne $version) {
    throw "Versions package/Tauri incohérentes ($version / $($tauriConfig.version))."
}
if ($tauriConfig.identifier -ne 'ch.helvichantier.desktop') {
    throw "Identifiant Tauri refusé : '$($tauriConfig.identifier)'."
}

$publicKey = [Environment]::GetEnvironmentVariable('ELYKO_UPDATER_PUBLIC_KEY')
$endpoint = [Environment]::GetEnvironmentVariable('ELYKO_UPDATER_ENDPOINT')
$privateKey = [Environment]::GetEnvironmentVariable('TAURI_SIGNING_PRIVATE_KEY')
if ([string]::IsNullOrWhiteSpace($publicKey) -or
    [string]::IsNullOrWhiteSpace($endpoint) -or
    [string]::IsNullOrWhiteSpace($privateKey)) {
    throw 'ELYKO_UPDATER_PUBLIC_KEY, ELYKO_UPDATER_ENDPOINT et TAURI_SIGNING_PRIVATE_KEY sont obligatoires pour ce build.'
}

$paths = Get-ZentraUpdaterArtifactPaths -DesktopRoot $desktopRoot -Version $version
[IO.Directory]::CreateDirectory($paths.ReleaseRoot) | Out-Null
foreach ($artifact in @($paths.Application, $paths.Installer, $paths.Signature, $paths.Provenance)) {
    Remove-ZentraExactBuildArtifact -Path $artifact -ReleaseRoot $paths.ReleaseRoot
}

$updaterTemplatePath = Join-Path $desktopRoot 'src-tauri\tauri.updater.conf.json'
$updaterTemplate = Get-Content -Raw -LiteralPath $updaterTemplatePath | ConvertFrom-Json
if ($updaterTemplate.plugins.updater.pubkey -ne 'INJECTED_BY_ELYKO_UPDATER_PUBLIC_KEY_AT_BUILD_TIME') {
    throw 'Le modèle de configuration updater ne contient pas le marqueur de clé publique attendu.'
}
$updaterTemplate.plugins.updater.pubkey = $publicKey.Trim()
$generatedUpdaterConfig = Join-Path $desktopRoot "src-tauri\tauri.updater.generated-$([Guid]::NewGuid().ToString('N')).conf.json"
[IO.File]::WriteAllText(
    $generatedUpdaterConfig,
    ($updaterTemplate | ConvertTo-Json -Depth 12),
    [Text.UTF8Encoding]::new($false)
)

$buildStartedAt = [DateTimeOffset]::UtcNow
Push-Location $desktopRoot
try {
    & pnpm exec tauri build --target $paths.Target --bundles nsis --config $generatedUpdaterConfig
    if ($LASTEXITCODE -ne 0) {
        throw "Le build Tauri updater a échoué avec le code $LASTEXITCODE."
    }
} finally {
    Pop-Location
    if (Test-Path -LiteralPath $generatedUpdaterConfig -PathType Leaf) {
        Remove-Item -LiteralPath $generatedUpdaterConfig -Force
    }
}

$provenance = Write-ZentraUpdaterBuildProvenance `
    -Paths $paths `
    -Version $version `
    -Identifier $tauriConfig.identifier `
    -Endpoint $endpoint `
    -PublicKey $publicKey `
    -BuildStartedAt $buildStartedAt

Write-Output "Build updater frais terminé : $($paths.Installer)"
Write-Output "Signature Tauri directe : $($paths.Signature)"
Write-Output "Preuve SHA-256 : $provenance"
