[CmdletBinding()]
param(
    # Ce chemin historique contient la clé qui signe déjà les versions Elyko.
    # Il doit rester stable pour que les anciennes installations puissent
    # authentifier les mises à jour Zentra.
    [string] $SigningRoot = (Join-Path $env:LOCALAPPDATA 'Elyko\release-signing'),
    [string] $Endpoint = 'https://xvfohjdlhlirksrvkiqu.supabase.co/storage/v1/object/public/zentra-releases/latest.json'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw 'LOCALAPPDATA est indisponible; le coffre local de signature ne peut pas être résolu.'
}

$privateKeyPath = Join-Path $SigningRoot 'elyko-updater.key'
$publicKeyPath = "$privateKeyPath.pub"
$passwordBlobPath = Join-Path $SigningRoot 'elyko-updater-password.dpapi'
foreach ($requiredPath in @($privateKeyPath, $publicKeyPath, $passwordBlobPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Secret de publication introuvable : $requiredPath"
    }
}

$endpointUri = $null
if (-not [Uri]::TryCreate($Endpoint, [UriKind]::Absolute, [ref]$endpointUri) -or
    $endpointUri.Scheme -ne 'https' -or
    -not [string]::IsNullOrEmpty($endpointUri.UserInfo) -or
    -not [string]::IsNullOrEmpty($endpointUri.Fragment)) {
    throw 'Endpoint refusé : une URL HTTPS absolue sans identifiants ni fragment est obligatoire.'
}

$passwordBytes = $null
$password = $null
try {
    $protectedPassword = [IO.File]::ReadAllBytes($passwordBlobPath)
    $passwordBytes = [Security.Cryptography.ProtectedData]::Unprotect(
        $protectedPassword,
        $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $password = [Text.Encoding]::UTF8.GetString($passwordBytes)
    if ([string]::IsNullOrWhiteSpace($password)) {
        throw 'Le secret DPAPI déchiffré est vide.'
    }

    $publicKey = (Get-Content -Raw -LiteralPath $publicKeyPath).Trim()
    try {
        $publicKeyDocument = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($publicKey))
    } catch {
        throw "La clé publique Tauri n’est pas en base64 standard."
    }
    if ($publicKeyDocument -notmatch '(?im)^untrusted comment:\s*minisign public key(?:\s*:\s*[0-9a-f]{16})?\s*$') {
        throw "La clé publique Tauri décodée n’est pas un document Minisign reconnu."
    }

    $env:ELYKO_UPDATER_PUBLIC_KEY = $publicKey
    $env:ELYKO_UPDATER_ENDPOINT = $endpointUri.AbsoluteUri
    $env:TAURI_SIGNING_PRIVATE_KEY = (Resolve-Path -LiteralPath $privateKeyPath).Path
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $password

    & (Join-Path $PSScriptRoot 'build-updater-release.ps1')
} finally {
    Remove-Item Env:ELYKO_UPDATER_PUBLIC_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:ELYKO_UPDATER_ENDPOINT -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
    if ($passwordBytes) {
        [Array]::Clear($passwordBytes, 0, $passwordBytes.Length)
    }
    $password = $null
}
