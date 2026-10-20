[CmdletBinding()]
param()
# Contrôle de la branche claude/erp-complet : typage, tests frontend des
# nouveaux modules, compilation native avec tous les tests, puis tests Rust
# des modules touchés. Ne construit ni installateur ni release.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:CIRCLECI -cne 'true' -or $env:CIRCLE_BRANCH -cne 'claude/erp-complet') {
    throw 'Ce contrôle est réservé à la branche claude/erp-complet sur CircleCI.'
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
        Invoke-Checked cargo (@('test', '--locked', '--manifest-path', $manifest, '--lib', '--') + $rustFilters + @('--test-threads=2'))
    }
} finally {
    Stop-Transcript | Out-Null
}
