Set-StrictMode -Version Latest

function Get-ElykoUpdaterArtifactPaths {
    param(
        [Parameter(Mandatory = $true)]
        [string] $DesktopRoot,

        [Parameter(Mandatory = $true)]
        [ValidatePattern('^\d+\.\d+\.\d+$')]
        [string] $Version
    )

    $desktopRootFull = [IO.Path]::GetFullPath($DesktopRoot)
    $target = 'x86_64-pc-windows-gnu'
    $releaseRoot = [IO.Path]::GetFullPath(
        (Join-Path $desktopRootFull "src-tauri\target\$target\release")
    )
    $installerName = "Elyko_${Version}_x64-setup.exe"
    $installer = [IO.Path]::GetFullPath(
        (Join-Path $releaseRoot "bundle\nsis\$installerName")
    )

    [pscustomobject]@{
        Target = $target
        ReleaseRoot = $releaseRoot
        Application = [IO.Path]::GetFullPath((Join-Path $releaseRoot 'Elyko.exe'))
        Installer = $installer
        Signature = "$installer.sig"
        Provenance = [IO.Path]::GetFullPath(
            (Join-Path $releaseRoot 'elyko-updater-build-provenance.json')
        )
    }
}

function Test-ElykoSamePath {
    param(
        [Parameter(Mandatory = $true)] [string] $Left,
        [Parameter(Mandatory = $true)] [string] $Right
    )

    return [string]::Equals(
        [IO.Path]::GetFullPath($Left).TrimEnd([char[]]@('\', '/')),
        [IO.Path]::GetFullPath($Right).TrimEnd([char[]]@('\', '/')),
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Resolve-ElykoCanonicalArtifactPath {
    param(
        [AllowNull()] [AllowEmptyString()] [string] $ProvidedPath,
        [Parameter(Mandatory = $true)] [string] $ExpectedPath,
        [Parameter(Mandatory = $true)] [string] $Label
    )

    $candidate = if ([string]::IsNullOrWhiteSpace($ProvidedPath)) {
        $ExpectedPath
    } else {
        $ProvidedPath
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "$Label introuvable : $candidate"
    }
    $resolved = (Resolve-Path -LiteralPath $candidate).Path
    if (-not (Test-ElykoSamePath $resolved $ExpectedPath)) {
        throw "$Label refusé : seul le chemin canonique du build frais est accepté ($ExpectedPath)."
    }
    return $resolved
}

function Get-ElykoTextSha256 {
    param([Parameter(Mandatory = $true)] [string] $Text)

    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '')
    } finally {
        $algorithm.Dispose()
    }
}

function Get-ElykoFileSha256 {
    param([Parameter(Mandatory = $true)] [string] $Path)

    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToUpperInvariant()
}

function Write-ElykoUpdaterBuildProvenance {
    param(
        [Parameter(Mandatory = $true)] $Paths,
        [Parameter(Mandatory = $true)] [string] $Version,
        [Parameter(Mandatory = $true)] [string] $Identifier,
        [Parameter(Mandatory = $true)] [string] $Endpoint,
        [Parameter(Mandatory = $true)] [string] $PublicKey,
        [Parameter(Mandatory = $true)] [DateTimeOffset] $BuildStartedAt
    )

    foreach ($artifact in @($Paths.Application, $Paths.Installer, $Paths.Signature)) {
        if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
            throw "Artefact attendu absent après le build : $artifact"
        }
        $artifactWriteTime = (Get-Item -LiteralPath $artifact).LastWriteTimeUtc
        if ($artifactWriteTime -lt $BuildStartedAt.UtcDateTime.AddSeconds(-2)) {
            throw "Artefact antérieur au build courant, refusé : $artifact"
        }
    }

    if (-not (Test-ElykoSamePath $Paths.Signature "$($Paths.Installer).sig")) {
        throw "La signature Tauri doit être le fichier .exe.sig de l’installateur NSIS."
    }

    $buildCompletedAt = [DateTimeOffset]::UtcNow
    $document = [ordered]@{
        schema = 'elyko.updater-build.v1'
        version = $Version
        target = $Paths.Target
        identifier = $Identifier
        build_started_at = $BuildStartedAt.ToString('o')
        build_completed_at = $buildCompletedAt.ToString('o')
        endpoint = $Endpoint.Trim()
        public_key_sha256 = (Get-ElykoTextSha256 ($PublicKey.Trim()))
        application = [ordered]@{
            path = [IO.Path]::GetFullPath($Paths.Application)
            sha256 = (Get-ElykoFileSha256 $Paths.Application)
        }
        installer = [ordered]@{
            path = [IO.Path]::GetFullPath($Paths.Installer)
            sha256 = (Get-ElykoFileSha256 $Paths.Installer)
        }
        signature = [ordered]@{
            path = [IO.Path]::GetFullPath($Paths.Signature)
            sha256 = (Get-ElykoFileSha256 $Paths.Signature)
        }
    }

    [IO.Directory]::CreateDirectory((Split-Path -Parent $Paths.Provenance)) | Out-Null
    $temporary = "$($Paths.Provenance).tmp-$([Guid]::NewGuid().ToString('N'))"
    try {
        [IO.File]::WriteAllText(
            $temporary,
            ($document | ConvertTo-Json -Depth 6),
            [Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $temporary -Destination $Paths.Provenance
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
    return $Paths.Provenance
}

function Assert-ElykoUpdaterBuildProvenance {
    param(
        [Parameter(Mandatory = $true)] $Paths,
        [Parameter(Mandatory = $true)] [string] $Version,
        [Parameter(Mandatory = $true)] [string] $Identifier,
        [Parameter(Mandatory = $true)] [string] $Endpoint,
        [Parameter(Mandatory = $true)] [string] $PublicKey,
        [Parameter(Mandatory = $true)] [string] $ProvenancePath,
        [ValidateRange(1, 168)] [int] $MaximumAgeHours = 24
    )

    $provenance = Get-Content -Raw -LiteralPath $ProvenancePath | ConvertFrom-Json
    if ($provenance.schema -ne 'elyko.updater-build.v1') {
        throw 'Preuve de build absente ou de format inconnu.'
    }
    if ($provenance.version -ne $Version -or
        $provenance.target -ne $Paths.Target -or
        $provenance.identifier -ne $Identifier) {
        throw "La preuve de build ne correspond pas à la version, la cible ou l’identifiant attendus."
    }
    if ($provenance.endpoint -ne $Endpoint.Trim() -or
        $provenance.public_key_sha256 -ne (Get-ElykoTextSha256 ($PublicKey.Trim()))) {
        throw 'La preuve de build ne correspond pas à la configuration updater compilée.'
    }

    try {
        $startedAt = [DateTimeOffset]$provenance.build_started_at
        $completedAt = [DateTimeOffset]$provenance.build_completed_at
    } catch {
        throw 'Les horodatages de la preuve de build sont invalides.'
    }
    $now = [DateTimeOffset]::UtcNow
    if ($completedAt -lt $startedAt -or $completedAt -gt $now.AddMinutes(5)) {
        throw 'La chronologie de la preuve de build est invalide.'
    }
    if (($now - $completedAt).TotalHours -gt $MaximumAgeHours) {
        throw "Le build a plus de $MaximumAgeHours heures; reconstruisez les artefacts avant la release."
    }

    $checks = @(
        @{ Label = 'exécutable'; ActualPath = $Paths.Application; Recorded = $provenance.application },
        @{ Label = 'installateur NSIS'; ActualPath = $Paths.Installer; Recorded = $provenance.installer },
        @{ Label = 'signature Tauri'; ActualPath = $Paths.Signature; Recorded = $provenance.signature }
    )
    foreach ($check in $checks) {
        if (-not (Test-ElykoSamePath $check.ActualPath $check.Recorded.path)) {
            throw "La preuve référence un autre $($check.Label)."
        }
        $currentHash = Get-ElykoFileSha256 $check.ActualPath
        if ($currentHash -ne $check.Recorded.sha256) {
            throw "Le SHA-256 du $($check.Label) a changé depuis le build frais."
        }
        if ((Get-Item -LiteralPath $check.ActualPath).LastWriteTimeUtc -lt $startedAt.UtcDateTime.AddSeconds(-2)) {
            throw "Le $($check.Label) est antérieur au build attesté."
        }
    }

    if (-not (Test-ElykoSamePath $Paths.Signature "$($Paths.Installer).sig")) {
        throw "La signature fournie n’est pas le .exe.sig direct de l’installateur NSIS."
    }
}
