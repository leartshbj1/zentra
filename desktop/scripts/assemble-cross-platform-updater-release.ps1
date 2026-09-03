[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string] $Version,

    [string] $WindowsReleaseDirectory,

    [Parameter(Mandatory = $true)]
    [string] $MacReleaseDirectory,

    [string] $OutputRoot,
    [string] $DownloadBaseUrl = 'https://xvfohjdlhlirksrvkiqu.supabase.co/storage/v1/object/public/zentra-releases',
    [string] $Notes = 'Version stable Zentra pour Windows et macOS.'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-RequiredFile([string] $Path, [string] $Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label introuvable : $Path"
    }
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    if ((Get-Item -LiteralPath $resolved).Length -le 0) {
        throw "$Label vide : $resolved"
    }
    return $resolved
}

function Assert-ChecksumLine(
    [string] $ChecksumPath,
    [string] $ArtifactPath,
    [string] $ExpectedName,
    [string] $Label
) {
    $expectedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ArtifactPath).Hash.ToUpperInvariant()
    $lines = @(Get-Content -LiteralPath $ChecksumPath | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $matched = $false
    foreach ($line in $lines) {
        if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
            $name = $Matches[2].Trim()
            if ($name -eq $ExpectedName) {
                if ($Matches[1].ToUpperInvariant() -ne $expectedHash) {
                    throw "$Label refusé : l’empreinte publiée ne correspond pas aux octets du fichier."
                }
                $matched = $true
            }
        }
    }
    if (-not $matched) {
        throw "$Label refusé : aucune empreinte SHA-256 exacte pour $ExpectedName."
    }
    return $expectedHash
}

function Assert-UpdaterSignature([string] $ArtifactPath, [string] $SignaturePath) {
    Push-Location $tauriRoot
    try {
        & cargo run --quiet --locked --example verify_updater_artifact -- $ArtifactPath $SignaturePath
        if ($LASTEXITCODE -ne 0) {
            throw "La signature Tauri/Ed25519 ne correspond pas à $([IO.Path]::GetFileName($ArtifactPath))."
        }
    } finally {
        Pop-Location
    }
}

$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repositoryRoot = (Resolve-Path (Join-Path $desktopRoot '..')).Path
$tauriRoot = Join-Path $desktopRoot 'src-tauri'
if ([string]::IsNullOrWhiteSpace($WindowsReleaseDirectory)) {
    $WindowsReleaseDirectory = Join-Path $repositoryRoot "outputs\updater-releases\Zentra-$Version-windows-x64"
}
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $repositoryRoot 'outputs\updater-releases'
}

$packageVersion = (Get-Content -Raw -LiteralPath (Join-Path $desktopRoot 'package.json') | ConvertFrom-Json).version
$tauriVersion = (Get-Content -Raw -LiteralPath (Join-Path $tauriRoot 'tauri.conf.json') | ConvertFrom-Json).version
if ($packageVersion -ne $Version -or $tauriVersion -ne $Version) {
    throw "Versions incohérentes : demandé=$Version, package.json=$packageVersion, tauri.conf.json=$tauriVersion."
}

$publicKey = [Environment]::GetEnvironmentVariable('ELYKO_UPDATER_PUBLIC_KEY')
if ([string]::IsNullOrWhiteSpace($publicKey)) {
    throw 'ELYKO_UPDATER_PUBLIC_KEY est obligatoire pour vérifier les deux signatures.'
}

$baseUri = [Uri]$DownloadBaseUrl.TrimEnd('/')
if (-not $baseUri.IsAbsoluteUri -or $baseUri.Scheme -ne 'https' -or [string]::IsNullOrWhiteSpace($baseUri.Host) -or -not [string]::IsNullOrEmpty($baseUri.UserInfo) -or -not [string]::IsNullOrEmpty($baseUri.Fragment)) {
    throw 'DownloadBaseUrl doit être une URL HTTPS absolue sans identifiants ni fragment.'
}

$windowsDirectory = (Resolve-Path -LiteralPath $WindowsReleaseDirectory).Path
$macDirectory = (Resolve-Path -LiteralPath $MacReleaseDirectory).Path
$windowsName = "Zentra_${Version}_x64-setup.exe"
$macArchiveName = "Zentra_${Version}_macos-universal.app.tar.gz"
$macDmgName = "Zentra_${Version}_macos-universal.dmg"

$windowsInstaller = Resolve-RequiredFile (Join-Path $windowsDirectory $windowsName) 'Installateur Windows'
$windowsSignature = Resolve-RequiredFile (Join-Path $windowsDirectory "$windowsName.sig") 'Signature Windows'
$windowsChecksum = Resolve-RequiredFile (Join-Path $windowsDirectory "$windowsName.sha256.txt") 'Empreinte Windows'
$macArchive = Resolve-RequiredFile (Join-Path $macDirectory $macArchiveName) 'Archive updater macOS'
$macSignature = Resolve-RequiredFile (Join-Path $macDirectory "$macArchiveName.sig") 'Signature macOS'
$macDmg = Resolve-RequiredFile (Join-Path $macDirectory $macDmgName) 'DMG macOS'
$macChecksums = Resolve-RequiredFile (Join-Path $macDirectory 'SHA256SUMS.txt') 'Empreintes macOS'

$windowsHash = Assert-ChecksumLine $windowsChecksum $windowsInstaller $windowsName 'Installateur Windows'
$macArchiveHash = Assert-ChecksumLine $macChecksums $macArchive $macArchiveName 'Archive updater macOS'
$macDmgHash = Assert-ChecksumLine $macChecksums $macDmg $macDmgName 'DMG macOS'
Assert-UpdaterSignature $windowsInstaller $windowsSignature
Assert-UpdaterSignature $macArchive $macSignature

$windowsSignatureText = (Get-Content -Raw -LiteralPath $windowsSignature).Trim()
$macSignatureText = (Get-Content -Raw -LiteralPath $macSignature).Trim()
foreach ($signatureText in @($windowsSignatureText, $macSignatureText)) {
    try {
        [void][Convert]::FromBase64String($signatureText)
    } catch {
        throw "Une signature updater n’est pas encodée en base64 standard."
    }
}

$outputRootFull = [IO.Path]::GetFullPath($OutputRoot)
[IO.Directory]::CreateDirectory($outputRootFull) | Out-Null
$releaseDirectory = Join-Path $outputRootFull "Zentra-$Version-cross-platform"
if (Test-Path -LiteralPath $releaseDirectory) {
    throw "Le lot existe déjà et ne sera pas écrasé : $releaseDirectory"
}
$partialDirectory = Join-Path $outputRootFull ".Zentra-$Version-cross-platform-partial-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($partialDirectory) | Out-Null

try {
    Copy-Item -LiteralPath $windowsInstaller -Destination (Join-Path $partialDirectory $windowsName)
    Copy-Item -LiteralPath $windowsSignature -Destination (Join-Path $partialDirectory "$windowsName.sig")
    Copy-Item -LiteralPath $windowsChecksum -Destination (Join-Path $partialDirectory "$windowsName.sha256.txt")
    Copy-Item -LiteralPath $macArchive -Destination (Join-Path $partialDirectory $macArchiveName)
    Copy-Item -LiteralPath $macSignature -Destination (Join-Path $partialDirectory "$macArchiveName.sig")
    Copy-Item -LiteralPath $macDmg -Destination (Join-Path $partialDirectory $macDmgName)
    Copy-Item -LiteralPath $macChecksums -Destination (Join-Path $partialDirectory 'SHA256SUMS.txt')
    [IO.File]::WriteAllText(
        (Join-Path $partialDirectory "$macDmgName.sha256.txt"),
        "$macDmgHash  $macDmgName`n",
        [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::WriteAllText(
        (Join-Path $partialDirectory "$macArchiveName.sha256.txt"),
        "$macArchiveHash  $macArchiveName`n",
        [Text.UTF8Encoding]::new($false)
    )

    $downloadOrigin = $baseUri.AbsoluteUri.TrimEnd('/')
    $manifest = [ordered]@{
        version = $Version
        notes = $Notes
        pub_date = [DateTimeOffset]::UtcNow.ToString('o')
        platforms = [ordered]@{
            'windows-x86_64' = [ordered]@{
                signature = $windowsSignatureText
                url = "$downloadOrigin/$windowsName"
            }
            'macos-universal' = [ordered]@{
                signature = $macSignatureText
                url = "$downloadOrigin/$macArchiveName"
            }
        }
    }
    $manifestPath = Join-Path $partialDirectory 'latest.json'
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))

    $verifiedManifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ($verifiedManifest.version -ne $Version -or
        $verifiedManifest.platforms.'windows-x86_64'.signature -ne $windowsSignatureText -or
        $verifiedManifest.platforms.'macos-universal'.signature -ne $macSignatureText) {
        throw 'Le manifeste final ne correspond pas aux deux signatures vérifiées.'
    }

    [IO.Directory]::Move($partialDirectory, $releaseDirectory)
} catch {
    throw "$($_.Exception.Message) Lot partiel conservé pour diagnostic : $partialDirectory"
}

Write-Output "Lot cross-platform validé et finalisé atomiquement : $releaseDirectory"
Write-Output "SHA-256 Windows : $windowsHash"
Write-Output "SHA-256 DMG macOS : $macDmgHash"
Write-Output "Publication non effectuée. Téléverser tous les fichiers avant latest.json."
