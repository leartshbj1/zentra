[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string] $Version,

    [string] $ApplicationExePath,

    [string] $InstallerPath,

    [string] $SignaturePath,

    [string] $BuildProvenancePath,

    [string] $OutputRoot,
    [string] $DownloadBaseUrl = 'https://elyko.alb-leart1.chatgpt.site/downloads',
    [string] $Notes = 'Mise à jour stable Elyko.',
    [string] $PreviousVersion = '1.2.0',
    [ValidateRange(1, 168)]
    [int] $MaximumBuildAgeHours = 24,
    [switch] $AllowDirtyWorktree,
    [switch] $AllowUnsignedAuthenticodeForTesting,
    [switch] $AllowUnsignedAuthenticodeForPublication
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'updater-release-provenance.ps1')

function Resolve-ExistingFile([string] $Path, [string] $Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label introuvable : $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Get-CargoPackageVersion([string] $ManifestPath) {
    $insidePackage = $false
    foreach ($line in Get-Content -LiteralPath $ManifestPath) {
        if ($line -match '^\s*\[(.+)\]\s*$') {
            $insidePackage = $Matches[1] -eq 'package'
            continue
        }
        if ($insidePackage -and $line -match '^\s*version\s*=\s*"([^"]+)"\s*$') {
            return $Matches[1]
        }
    }
    throw "Version [package] absente de $ManifestPath"
}

function Assert-ValidAuthenticode([string] $Path, [string] $Label) {
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        if ($AllowUnsignedAuthenticodeForTesting) {
            Write-Warning "$Label non signé Authenticode : ce lot est réservé aux tests et ne doit pas être publié."
            return
        }
        if ($AllowUnsignedAuthenticodeForPublication) {
            Write-Warning "$Label non signé Authenticode : publication explicitement autorisée par le propriétaire. Windows peut afficher Éditeur inconnu."
            return
        }
        throw "$Label refusé : signature Authenticode non valide ($($signature.Status))."
    }
}

if ($AllowUnsignedAuthenticodeForTesting -and $AllowUnsignedAuthenticodeForPublication) {
    throw 'Choisissez un seul mode de tolérance Authenticode : test ou publication autorisée.'
}

$desktopRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repositoryRoot = (Resolve-Path (Join-Path $desktopRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $repositoryRoot 'outputs\updater-releases'
}

$artifactPaths = Get-ElykoUpdaterArtifactPaths -DesktopRoot $desktopRoot -Version $Version
$applicationExe = Resolve-ElykoCanonicalArtifactPath `
    -ProvidedPath $ApplicationExePath `
    -ExpectedPath $artifactPaths.Application `
    -Label 'Exécutable Elyko'
$installer = Resolve-ElykoCanonicalArtifactPath `
    -ProvidedPath $InstallerPath `
    -ExpectedPath $artifactPaths.Installer `
    -Label 'Installateur NSIS'
$signature = Resolve-ElykoCanonicalArtifactPath `
    -ProvidedPath $SignaturePath `
    -ExpectedPath $artifactPaths.Signature `
    -Label "Signature Tauri directe de l’installateur NSIS"
$provenancePath = Resolve-ElykoCanonicalArtifactPath `
    -ProvidedPath $BuildProvenancePath `
    -ExpectedPath $artifactPaths.Provenance `
    -Label 'Preuve du build updater'
$outputRootFull = [System.IO.Path]::GetFullPath($OutputRoot)
$packageJsonPath = Join-Path $desktopRoot 'package.json'
$tauriConfigPath = Join-Path $desktopRoot 'src-tauri\tauri.conf.json'
$cargoManifestPath = Join-Path $desktopRoot 'src-tauri\Cargo.toml'
$cargoLockPath = Join-Path $desktopRoot 'src-tauri\Cargo.lock'

$packageVersion = (Get-Content -Raw -LiteralPath $packageJsonPath | ConvertFrom-Json).version
$tauriConfig = Get-Content -Raw -LiteralPath $tauriConfigPath | ConvertFrom-Json
$cargoVersion = Get-CargoPackageVersion $cargoManifestPath
$lockText = Get-Content -Raw -LiteralPath $cargoLockPath
$lockMatch = [regex]::Match($lockText, '(?ms)^\[\[package\]\]\s*\r?\nname\s*=\s*"helvichantier"\s*\r?\nversion\s*=\s*"([^"]+)"')
if (-not $lockMatch.Success) {
    throw 'Version du paquet helvichantier absente de Cargo.lock.'
}
$lockVersion = $lockMatch.Groups[1].Value
$versions = @(@($packageVersion, $tauriConfig.version, $cargoVersion, $lockVersion) | Select-Object -Unique)
if ($versions.Count -ne 1 -or $versions[0] -ne $Version) {
    throw "Versions incohérentes : demandé=$Version, package.json=$packageVersion, tauri.conf.json=$($tauriConfig.version), Cargo.toml=$cargoVersion, Cargo.lock=$lockVersion."
}
if ($tauriConfig.identifier -ne 'ch.helvichantier.desktop') {
    throw "Identifiant Tauri refusé : '$($tauriConfig.identifier)'. Conserver ch.helvichantier.desktop pour préserver les données locales."
}
if ([version]$Version -le [version]$PreviousVersion) {
    throw "La version $Version doit être strictement supérieure à $PreviousVersion."
}

if (-not $AllowDirtyWorktree) {
    Push-Location $repositoryRoot
    try {
        $gitStatus = @(& git status --porcelain --untracked-files=normal)
        if ($LASTEXITCODE -ne 0) { throw 'git status a échoué.' }
        if ($gitStatus.Count -gt 0) {
            throw 'Worktree non propre. Committez et validez les changements avant de préparer une release.'
        }
    } finally {
        Pop-Location
    }
}

$expectedInstallerName = "Elyko_${Version}_x64-setup.exe"
if ([System.IO.Path]::GetFileName($installer) -ne $expectedInstallerName) {
    throw "Nom d’installateur incohérent : attendu $expectedInstallerName."
}
if ([System.IO.Path]::GetFileName($signature) -ne "$expectedInstallerName.sig") {
    throw "Nom de signature incohérent : attendu $expectedInstallerName.sig."
}

$publicKey = [Environment]::GetEnvironmentVariable('ELYKO_UPDATER_PUBLIC_KEY')
$endpoint = [Environment]::GetEnvironmentVariable('ELYKO_UPDATER_ENDPOINT')
if ([string]::IsNullOrWhiteSpace($publicKey) -or [string]::IsNullOrWhiteSpace($endpoint)) {
    throw 'ELYKO_UPDATER_PUBLIC_KEY et ELYKO_UPDATER_ENDPOINT doivent être définis dans le processus qui valide le build.'
}
try {
    $publicKeyDocument = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($publicKey.Trim()))
} catch {
    throw "ELYKO_UPDATER_PUBLIC_KEY n’est pas un document Minisign encodé en base64 standard."
}
if ($publicKeyDocument -notmatch '(?im)^untrusted comment:\s*minisign public key(?:\s*:\s*[0-9a-f]{16})?\s*$' -or $publicKeyDocument -match '(?i)private key') {
    throw 'ELYKO_UPDATER_PUBLIC_KEY ne contient pas une clé publique Minisign reconnue.'
}

$baseUri = [Uri]$DownloadBaseUrl.TrimEnd('/')
if (-not $baseUri.IsAbsoluteUri -or $baseUri.Scheme -ne 'https' -or [string]::IsNullOrWhiteSpace($baseUri.Host) -or -not [string]::IsNullOrEmpty($baseUri.UserInfo) -or -not [string]::IsNullOrEmpty($baseUri.Fragment)) {
    throw 'DownloadBaseUrl doit être une URL HTTPS absolue sans identifiants ni fragment.'
}
$expectedEndpoint = "$($baseUri.AbsoluteUri.TrimEnd('/'))/latest.json"
if ($endpoint.Trim() -ne $expectedEndpoint) {
    throw "Endpoint incohérent : le build doit embarquer $expectedEndpoint."
}

Assert-ElykoUpdaterBuildProvenance `
    -Paths $artifactPaths `
    -Version $Version `
    -Identifier $tauriConfig.identifier `
    -Endpoint $endpoint `
    -PublicKey $publicKey `
    -ProvenancePath $provenancePath `
    -MaximumAgeHours $MaximumBuildAgeHours

$applicationBytes = [IO.File]::ReadAllBytes($applicationExe)
$applicationText = [Text.Encoding]::GetEncoding(28591).GetString($applicationBytes)
if (-not $applicationText.Contains($endpoint.Trim())) {
    throw "L’exécutable ne contient pas l’endpoint attendu; rebuild updater obligatoire."
}
if (-not $applicationText.Contains($publicKey.Trim())) {
    throw "L’exécutable ne contient pas la clé publique attendue; rebuild updater obligatoire."
}

Assert-ValidAuthenticode $applicationExe 'Exécutable Elyko'
Assert-ValidAuthenticode $installer 'Installateur NSIS'

Push-Location (Join-Path $desktopRoot 'src-tauri')
try {
    & cargo run --quiet --locked --example verify_updater_artifact -- $installer $signature
    if ($LASTEXITCODE -ne 0) {
        throw "La signature Tauri/Ed25519 ne correspond pas exactement à l’installateur."
    }
} finally {
    Pop-Location
}

[IO.Directory]::CreateDirectory($outputRootFull) | Out-Null
$releaseDirectory = Join-Path $outputRootFull "Elyko-$Version-windows-x64"
if (Test-Path -LiteralPath $releaseDirectory) {
    throw "Le lot existe déjà et ne sera pas écrasé : $releaseDirectory"
}
$partialDirectory = Join-Path $outputRootFull ".Elyko-$Version-partial-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($partialDirectory) | Out-Null

try {
    $stagedInstaller = Join-Path $partialDirectory $expectedInstallerName
    $stagedSignature = Join-Path $partialDirectory "$expectedInstallerName.sig"
    Copy-Item -LiteralPath $installer -Destination $stagedInstaller
    Copy-Item -LiteralPath $signature -Destination $stagedSignature

    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $stagedInstaller).Hash.ToUpperInvariant()
    $checksumName = "$expectedInstallerName.sha256.txt"
    $checksumPath = Join-Path $partialDirectory $checksumName
    [IO.File]::WriteAllText($checksumPath, "$hash  $expectedInstallerName`n", [Text.UTF8Encoding]::new($false))

    $signatureText = (Get-Content -Raw -LiteralPath $stagedSignature).Trim()
    if ([string]::IsNullOrWhiteSpace($signatureText)) { throw 'Le fichier .sig est vide.' }
    try { [void][Convert]::FromBase64String($signatureText) } catch { throw "Le fichier .sig n’est pas en base64 standard." }

    $downloadUrl = "$($baseUri.AbsoluteUri.TrimEnd('/'))/$expectedInstallerName"
    $manifest = [ordered]@{
        version = $Version
        notes = $Notes
        pub_date = [DateTimeOffset]::UtcNow.ToString('o')
        platforms = [ordered]@{
            'windows-x86_64' = [ordered]@{
                signature = $signatureText
                url = $downloadUrl
            }
        }
    }
    $manifestPath = Join-Path $partialDirectory 'latest.json'
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))

    $verifiedManifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $platform = $verifiedManifest.platforms.'windows-x86_64'
    $verifiedHashLine = (Get-Content -Raw -LiteralPath $checksumPath).Trim()
    $verifiedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $stagedInstaller).Hash.ToUpperInvariant()
    if ($verifiedManifest.version -ne $Version -or $platform.url -ne $downloadUrl -or $platform.signature -ne $signatureText) {
        throw "latest.json est incohérent avec la version, l’URL ou la signature du lot."
    }
    if ($verifiedHashLine -ne "$verifiedHash  $expectedInstallerName") {
        throw "Le fichier SHA-256 est incohérent avec l’installateur du lot."
    }
    if ((Get-Item -LiteralPath $stagedInstaller).Length -le 0) {
        throw "L’installateur du lot est vide."
    }

    [IO.Directory]::Move($partialDirectory, $releaseDirectory)
} catch {
    throw "$($_.Exception.Message) Lot partiel conservé pour diagnostic : $partialDirectory"
}

Write-Output "Lot updater validé et finalisé atomiquement : $releaseDirectory"
Write-Output "Publication non effectuée. Déployer ensemble l’EXE, le .sig, le SHA-256 et latest.json."
