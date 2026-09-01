[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'updater-release-provenance.ps1')

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "elyko-updater-provenance-test-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null

try {
    $desktopRoot = Join-Path $temporaryRoot 'desktop'
    $paths = Get-ZentraUpdaterArtifactPaths -DesktopRoot $desktopRoot -Version '9.9.9'
    [IO.Directory]::CreateDirectory((Split-Path -Parent $paths.Application)) | Out-Null
    [IO.Directory]::CreateDirectory((Split-Path -Parent $paths.Installer)) | Out-Null
    [IO.File]::WriteAllBytes($paths.Application, [byte[]](1, 2, 3, 4))
    [IO.File]::WriteAllBytes($paths.Installer, [byte[]](5, 6, 7, 8))
    [IO.File]::WriteAllText($paths.Signature, 'c2lnbmF0dXJl', [Text.UTF8Encoding]::new($false))

    $renamedOldInstaller = Join-Path $temporaryRoot 'Zentra_9.9.9_x64-setup.exe'
    [IO.File]::WriteAllBytes($renamedOldInstaller, [byte[]](9, 9, 9))
    $renamedRejected = $false
    try {
        [void](Resolve-ZentraCanonicalArtifactPath `
            -ProvidedPath $renamedOldInstaller `
            -ExpectedPath $paths.Installer `
            -Label 'Installateur NSIS')
    } catch {
        if ($_.Exception.Message -notmatch 'chemin canonique') {
            throw
        }
        $renamedRejected = $true
    }
    if (-not $renamedRejected) {
        throw 'ÉCHEC : un ancien NSIS renommé hors du build canonique a été accepté.'
    }

    $endpoint = 'https://example.invalid/downloads/latest.json'
    $publicKey = 'public-key-test'
    $provenance = Write-ZentraUpdaterBuildProvenance `
        -Paths $paths `
        -Version '9.9.9' `
        -Identifier 'ch.helvichantier.desktop' `
        -Endpoint $endpoint `
        -PublicKey $publicKey `
        -BuildStartedAt ([DateTimeOffset]::UtcNow.AddMinutes(-1))

    Assert-ZentraUpdaterBuildProvenance `
        -Paths $paths `
        -Version '9.9.9' `
        -Identifier 'ch.helvichantier.desktop' `
        -Endpoint $endpoint `
        -PublicKey $publicKey `
        -ProvenancePath $provenance

    [IO.File]::WriteAllBytes($paths.Installer, [byte[]](8, 7, 6, 5))
    $tamperRejected = $false
    try {
        Assert-ZentraUpdaterBuildProvenance `
            -Paths $paths `
            -Version '9.9.9' `
            -Identifier 'ch.helvichantier.desktop' `
            -Endpoint $endpoint `
            -PublicKey $publicKey `
            -ProvenancePath $provenance
    } catch {
        if ($_.Exception.Message -notmatch 'SHA-256') {
            throw
        }
        $tamperRejected = $true
    }
    if (-not $tamperRejected) {
        throw 'ÉCHEC : un NSIS remplacé après le build a été accepté.'
    }

    Write-Output 'PASS : chemins canoniques et preuve SHA-256 refusent les NSIS substitués.'
} finally {
    $resolvedTemporaryRoot = [IO.Path]::GetFullPath($temporaryRoot)
    $systemTemporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedTemporaryRoot.StartsWith($systemTemporaryRoot, [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolvedTemporaryRoot).StartsWith('elyko-updater-provenance-test-', [StringComparison]::Ordinal)) {
        [IO.Directory]::Delete($resolvedTemporaryRoot, $true)
    }
}
