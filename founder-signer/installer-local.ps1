[CmdletBinding()]
param([switch]$Build)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$sourceRoot = $PSScriptRoot
$repoRoot = Split-Path -Parent $sourceRoot
$installRoot = Join-Path $env:LOCALAPPDATA 'ZentraFondateur'
$vaultRoot = Join-Path $installRoot 'vault'
$binary = Join-Path $sourceRoot 'target\release\ZentraFondateur.exe'
if ($Build) {
    & cargo build --manifest-path (Join-Path $sourceRoot 'Cargo.toml') --release --locked --target-dir (Join-Path $sourceRoot 'target')
    if ($LASTEXITCODE -ne 0) { throw 'La compilation a échoué.' }
}
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "Compilez d'abord avec installer-local.ps1 -Build." }
New-Item -ItemType Directory -Path $installRoot,$vaultRoot -Force | Out-Null

# Keep the vault readable by this Windows user and SYSTEM only. DPAPI adds
# encryption bound to this same user. No clear private key is written here.
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $vaultRoot /inheritance:r /grant:r ('*'+$userSid+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Impossible de proteger les permissions du coffre.' }
foreach ($rule in @((Get-Acl -LiteralPath $vaultRoot).Access)) {
    $ruleSid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($ruleSid -ne $userSid -and $ruleSid -ne 'S-1-5-18') {
        & icacls.exe $vaultRoot /remove ('*'+$ruleSid) | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Impossible de limiter les permissions du coffre.' }
    }
}

$keySource = Join-Path $repoRoot 'secrets\license-signing-key.dpapi'
$keyDestination = Join-Path $vaultRoot 'license-signing-key.dpapi'
if (-not (Test-Path -LiteralPath $keyDestination)) {
    if (-not (Test-Path -LiteralPath $keySource)) { throw 'La clé protégée Zentra est absente de secrets.' }
    Copy-Item -LiteralPath $keySource -Destination $keyDestination
}
Get-ChildItem -LiteralPath (Join-Path $repoRoot 'secrets') -Filter 'owner-license-token*.dpapi' -File | ForEach-Object {
    $destination = Join-Path $vaultRoot $_.Name
    if (-not (Test-Path -LiteralPath $destination)) { Copy-Item -LiteralPath $_.FullName -Destination $destination }
}
$installedBinary = Join-Path $installRoot 'ZentraFondateur.exe'
Get-Process -Name ZentraFondateur -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $installedBinary } | Stop-Process
Copy-Item -LiteralPath $binary -Destination $installedBinary -Force
# The Windows GNU build imports Microsoft's WebView2 loader dynamically.
# Cargo makes it available to tests, but a desktop shortcut needs it beside
# the executable. Only take the x64 loader from this application's build.
$loaders = @(Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'target\release\build') -Directory -Filter 'webview2-com-sys-*' | ForEach-Object {
    $loader = Join-Path $_.FullName 'out\x64\WebView2Loader.dll'
    if (Test-Path -LiteralPath $loader -PathType Leaf) { Get-Item -LiteralPath $loader }
})
if (-not $loaders.Count) { throw 'Le composant WebView2Loader x64 manque dans la compilation.' }
$loaderHashes = @($loaders | ForEach-Object { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } | Select-Object -Unique)
if ($loaderHashes.Count -ne 1) { throw 'Plusieurs versions du composant WebView2 existent dans le build. Verifiez la version utilisee.' }
Copy-Item -LiteralPath $loaders[0].FullName -Destination (Join-Path $installRoot 'WebView2Loader.dll') -Force
Copy-Item -LiteralPath (Join-Path $sourceRoot 'README.md') -Destination (Join-Path $installRoot 'Mode-emploi.md') -Force
$report = Join-Path $installRoot 'installation-check.json'
$publicKeyFile = Join-Path $installRoot 'founder-admin-public-key.b64url'
$prepare = Start-Process -FilePath $installedBinary -ArgumentList ('--prepare-access-key "'+$publicKeyFile+'"') -WindowStyle Hidden -Wait -PassThru
if ($prepare.ExitCode -ne 0) { throw 'La preparation de la cle de gestion des acces a echoue.' }
$checkArgs = '--check-installation "' + $report + '"'
$check = Start-Process -FilePath $installedBinary -ArgumentList $checkArgs -WindowStyle Hidden -Wait -PassThru
if ($check.ExitCode -ne 0) { throw 'La vérification du coffre a échoué. Consultez installation-check.json.' }
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Programs'))) {
    $shortcut = $shell.CreateShortcut((Join-Path $folder 'Zentra Fondateur.lnk'))
    $shortcut.TargetPath = $installedBinary
    $shortcut.WorkingDirectory = $installRoot
    $shortcut.IconLocation = "$installedBinary,0"
    $shortcut.Description = "Accorder, prolonger et retirer un acces Zentra par e-mail"
    $shortcut.Save()
}
Write-Output "Application installée : $installedBinary"
Get-Content -LiteralPath $report
