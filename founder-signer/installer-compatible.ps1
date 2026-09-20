[CmdletBinding()]
param([string]$InstallRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$taskShell=New-Object -ComObject WScript.Shell
$taskDesktopLink=Join-Path ([Environment]::GetFolderPath('Desktop')) 'Zentra Fondateur.lnk'
if (-not $InstallRoot) {
    if (Test-Path -LiteralPath $taskDesktopLink) {
        $taskExisting=$taskShell.CreateShortcut($taskDesktopLink)
        if ($taskExisting.WorkingDirectory -like '*\ZentraFondateur' -and (Test-Path -LiteralPath (Join-Path $taskExisting.WorkingDirectory 'vault/founder-admin-key.dpapi'))) { $InstallRoot=$taskExisting.WorkingDirectory }
        elseif ($taskExisting.TargetPath -like '*\ZentraFondateur\ZentraFondateur.exe') { $InstallRoot=Split-Path -Parent $taskExisting.TargetPath }
    }
    if (-not $InstallRoot) { $InstallRoot=Join-Path $env:LOCALAPPDATA 'ZentraFondateur' }
}
$InstallRoot=[IO.Path]::GetFullPath($InstallRoot)
if ([IO.Path]::GetFileName($InstallRoot) -ne 'ZentraFondateur' -or -not $InstallRoot.StartsWith(([IO.Path]::GetFullPath($env:USERPROFILE)+'\'),[StringComparison]::OrdinalIgnoreCase)) {throw 'Choisissez le dossier personnel ZentraFondateur dans votre profil Windows.'}
if (-not (Test-Path -LiteralPath (Join-Path $InstallRoot 'vault/founder-admin-key.dpapi'))) { throw 'Le coffre fondateur existant est requis. Aucune nouvelle cle ne sera creee.' }
$taskNode=(Get-Command node -ErrorAction Stop).Source
$taskNodeSignature=Get-AuthenticodeSignature -LiteralPath $taskNode
if ($taskNodeSignature.Status -ne 'Valid' -or $taskNodeSignature.SignerCertificate.Subject -notmatch 'OpenJS Foundation|Node.js Foundation') { throw 'Un moteur Node.js officiellement signe est requis.' }
$taskEdge=@('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe') | Where-Object {Test-Path -LiteralPath $_} | Select-Object -First 1
if (-not $taskEdge -or (Get-AuthenticodeSignature -LiteralPath $taskEdge).Status -ne 'Valid') { throw 'Microsoft Edge signe est requis.' }
$taskSessionFile=Join-Path $InstallRoot 'local-session.json'
if (Test-Path -LiteralPath $taskSessionFile) {
    $taskPrevious=Get-Content -LiteralPath $taskSessionFile -Raw | ConvertFrom-Json
    $taskProcess=Get-Process -Id $taskPrevious.pid -ErrorAction SilentlyContinue
    if ($taskProcess -and $taskProcess.Path -eq (Join-Path $InstallRoot 'runtime/node.exe')) {Stop-Process -Id $taskProcess.Id; $taskProcess.WaitForExit()}
}
New-Item -ItemType Directory -Path (Join-Path $InstallRoot 'runtime'),(Join-Path $InstallRoot 'windows-local'),(Join-Path $InstallRoot 'ui') -Force | Out-Null
$taskSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $InstallRoot /inheritance:r /grant:r ('*'+$taskSid+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Impossible de proteger le dossier personnel.' }
foreach ($taskRule in @((Get-Acl -LiteralPath $InstallRoot).Access)) {
    $taskRuleSid=$taskRule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($taskRuleSid -ne $taskSid -and $taskRuleSid -ne 'S-1-5-18') { & icacls.exe $InstallRoot /remove ('*'+$taskRuleSid) | Out-Null; if ($LASTEXITCODE -ne 0) {throw 'Permissions du dossier indisponibles.'} }
}
Copy-Item -LiteralPath $taskNode -Destination (Join-Path $InstallRoot 'runtime/node.exe') -Force
if ((Get-AuthenticodeSignature -LiteralPath (Join-Path $InstallRoot 'runtime/node.exe')).Status -ne 'Valid') { throw 'Signature du composant installe invalide.' }
foreach ($taskFolder in @('windows-local','ui')) {
    Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot $taskFolder) -File | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $InstallRoot ($taskFolder+'/'+$_.Name)) -Force}
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $InstallRoot 'Mode-emploi.md') -Force
if ((Test-Path -LiteralPath $taskDesktopLink) -and -not (Test-Path -LiteralPath (Join-Path $InstallRoot 'Ancien raccourci.lnk'))) {Copy-Item -LiteralPath $taskDesktopLink -Destination (Join-Path $InstallRoot 'Ancien raccourci.lnk')}
foreach ($taskFolder in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Programs'))) {
    $taskLink=$taskShell.CreateShortcut((Join-Path $taskFolder 'Zentra Fondateur.lnk'))
    $taskLink.TargetPath=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $taskNodePath=(Join-Path $InstallRoot 'runtime/node.exe').Replace("'","''")
    $taskServerPath=(Join-Path $InstallRoot 'windows-local/server.mjs').Replace("'","''")
    $taskWorkingPath=$InstallRoot.Replace("'","''")
    $taskCommand="Start-Process -FilePath '$taskNodePath' -ArgumentList ('{0}{1}{0}' -f [char]34,'$taskServerPath') -WorkingDirectory '$taskWorkingPath' -WindowStyle Hidden"
    $taskLink.Arguments='-NoProfile -NonInteractive -WindowStyle Hidden -Command "'+$taskCommand+'"'
    $taskLink.WorkingDirectory=$InstallRoot
    $taskLink.IconLocation=(Join-Path $InstallRoot 'ZentraFondateur.exe')+',0'
    $taskLink.Description='Gestion personnelle des acces Zentra'
    $taskLink.Save()
}
Write-Output ('Zentra Fondateur local installe : '+$InstallRoot)
