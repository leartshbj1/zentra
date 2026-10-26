[CmdletBinding()]
param()
# Contrôle de la branche claude/erp-complet : typage, tests frontend des
# nouveaux modules, compilation native avec tous les tests, puis tests Rust
# des modules touchés. Ne construit ni installateur ni release.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:CIRCLECI -cne 'true' -or $env:CIRCLE_BRANCH -cnotin @('claude/erp-complet', 'claude/bank-near-payment', 'claude/pack-batiment', 'claude/paiements-surs', 'claude/integration-1-90-49')) {
    throw 'Ce contrôle est réservé aux branches de contrôle ERP sur CircleCI.'
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $repo
$artifacts = Join-Path $repo 'desktop/artifacts/erp'
[IO.Directory]::CreateDirectory($artifacts) | Out-Null
$toolsRoot = Join-Path $env:TEMP 'zentra-erp-tools'
[IO.Directory]::CreateDirectory($toolsRoot) | Out-Null

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed ($LASTEXITCODE)" }
}

$nodeBase = 'https://nodejs.org/dist/latest-v22.x'
$sums = (Invoke-WebRequest -UseBasicParsing "$nodeBase/SHASUMS256.txt").Content
$match = [regex]::Match($sums, '(?m)^([a-f0-9]{64})\s+(node-v22\.[0-9]+\.[0-9]+-win-x64\.zip)\s*$')
if (-not $match.Success) { throw 'Node 22 checksum not found' }
$zipName = $match.Groups[2].Value
$zipPath = Join-Path $toolsRoot $zipName
Invoke-WebRequest -UseBasicParsing "$nodeBase/$zipName" -OutFile $zipPath
if ((Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $match.Groups[1].Value) { throw 'Node checksum mismatch' }
Expand-Archive -LiteralPath $zipPath -DestinationPath $toolsRoot -Force
$nodeRoot = Join-Path $toolsRoot ([IO.Path]::GetFileNameWithoutExtension($zipName))
$env:PATH = "$nodeRoot;$env:APPDATA\npm;$env:USERPROFILE\.cargo\bin;$env:PATH"
Invoke-Checked npm.cmd @('install', '--global', 'pnpm@11.19.0', '--no-audit', '--no-fund')

if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) {
    $installer = Join-Path $toolsRoot 'rustup-init.exe'
    Invoke-WebRequest -UseBasicParsing 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' -OutFile $installer
    $checksumContent = (Invoke-WebRequest -UseBasicParsing 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe.sha256').Content
    $checksumText = if ($checksumContent -is [byte[]]) { [Text.Encoding]::UTF8.GetString($checksumContent) } else { [string]$checksumContent }
    $expected = ($checksumText.Trim() -split '\s+')[0]
    if ($expected -notmatch '^[a-f0-9]{64}$') { throw 'Invalid Rustup checksum document' }
    if ((Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Rustup checksum mismatch' }
    Invoke-Checked $installer @('-y', '--profile', 'minimal', '--default-toolchain', 'stable-x86_64-pc-windows-msvc')
}
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
$env:CARGO_PROFILE_TEST_DEBUG = '0'
Invoke-Checked rustup @('toolchain', 'install', $env:RUSTUP_TOOLCHAIN, '--profile', 'minimal')
Invoke-Checked pnpm.cmd @('install', '--frozen-lockfile')

Start-Transcript -Path (Join-Path $artifacts 'erp-check.log') | Out-Null
try {
    # build:web lance aussi tsc --noEmit ; les ressources web sont embarquées par Tauri.
    Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'build:web')
    $frontendSuites = @(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'erp-check-suites.txt') | Where-Object { $_ -match '^src/' })
    if ($frontendSuites.Count -gt 0) {
        Invoke-Checked pnpm.cmd (@('--dir', 'desktop', 'exec', 'vitest', 'run', '--maxWorkers=2') + $frontendSuites)
    }
    $manifest = 'desktop/src-tauri/Cargo.toml'
    Invoke-Checked cargo @('check', '--locked', '--all-targets', '--manifest-path', $manifest)
    $rustFilters = @(Get-Content -LiteralPath (Join-Path $PSScriptRoot 'erp-check-suites.txt') | Where-Object { $_ -match '^rust:' } | ForEach-Object { $_.Substring(5).Trim() })
    if ($rustFilters.Count -gt 0) {
        # Le binaire de test Tauri importe TaskDialogIndirect (comctl32 v6) :
        # sans manifeste il s'arrête avec STATUS_ENTRYPOINT_NOT_FOUND. On lui
        # ajoute la dépendance Common-Controls v6, puis on le lance.
        $build = @(& cargo test --locked --manifest-path $manifest --lib --no-run --message-format=json)
        if ($LASTEXITCODE -ne 0) { throw "cargo test --no-run failed ($LASTEXITCODE)" }
        $executable = $null
        foreach ($line in $build) {
            if ($line -notmatch '"executable":"') { continue }
            $message = $line | ConvertFrom-Json
            if ($message.reason -eq 'compiler-artifact' -and $message.executable -and $message.profile.test -and ($message.target.kind -contains 'lib' -or $message.target.kind -contains 'cdylib' -or $message.target.kind -contains 'staticlib')) { $executable = $message.executable }
        }
        if (-not $executable) { throw 'Test executable not found.' }
        $mt = Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter mt.exe -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match '\\x64\\mt\.exe$' } | Sort-Object FullName -Descending | Select-Object -First 1
        if (-not $mt) { throw 'mt.exe not found.' }
        $manifestPath = Join-Path $artifacts 'test-harness.manifest'
        [IO.File]::WriteAllText($manifestPath, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/></dependentAssembly></dependency></assembly>', [Text.UTF8Encoding]::new($false))
        Invoke-Checked $mt.FullName @('-nologo', '-manifest', $manifestPath, "-outputresource:$executable;#1")
        Push-Location (Join-Path $repo 'desktop/src-tauri')
        try { Invoke-Checked $executable ($rustFilters + @('--test-threads=2')) } finally { Pop-Location }
    }
} finally {
    Stop-Transcript | Out-Null
}
