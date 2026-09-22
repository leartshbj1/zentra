[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $repo
$artifacts = Join-Path $repo 'desktop/artifacts/windows'
[IO.Directory]::CreateDirectory($artifacts) | Out-Null
$toolsRoot = Join-Path $env:TEMP 'zentra-release-tools'
[IO.Directory]::CreateDirectory($toolsRoot) | Out-Null

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed ($LASTEXITCODE)" }
}

# Use vendor-hosted Node binaries, checked against the vendor's SHA-256 list.
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
Start-Transcript -Path (Join-Path $artifacts 'validation.log') | Out-Null
try {
    Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'exec', 'vitest', 'run', 'src/companyAccount.test.ts', 'src/companyRealtime.test.ts', 'src/projectSyncScheduler.test.ts', 'src/automationCompanySession.test.ts', 'src/appReleaseNotes.test.ts', 'src/automationDailySummary.test.tsx', 'src/automationHub.test.tsx', 'src/supplierInboxReview.test.ts', 'src/supplierInboxBatch.test.ts', 'src/languageCatalogCoverage.test.ts', 'src/projectReport.test.ts')
    Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'build:web')
    Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'exec', 'vitest', 'run', 'src/quoteInterlocutor.test.ts')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'quote_interlocutor', '--', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'sales_pdf::tests', '--', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'company_', '--', '--nocapture', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'account_cloud::tests', '--', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'backup::tests', '--', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'supplier_inbox::tests', '--', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'appointment_inbox::tests', '--', '--test-threads=1')
    Invoke-Checked cargo @('test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--lib', 'project_report::tests', '--', '--test-threads=1')
    if ($env:ZENTRA_VERIFY_ONLY -eq 'true') { return }
    $config = Get-Content desktop/src-tauri/tauri.updater.conf.json -Raw | ConvertFrom-Json
    $config.bundle.createUpdaterArtifacts = $false
    $env:ELYKO_UPDATER_PUBLIC_KEY = (Get-Content desktop/src-tauri/updater-public-key.txt -Raw).Trim()
    $env:ELYKO_UPDATER_ENDPOINT = 'https://xvfohjdlhlirksrvkiqu.supabase.co/storage/v1/object/public/zentra-releases/latest-windows.json'
    $config.plugins.updater.pubkey = $env:ELYKO_UPDATER_PUBLIC_KEY
    $generated = Join-Path $repo 'desktop/src-tauri/tauri.updater.generated-cloud.conf.json'
    [IO.File]::WriteAllText($generated, ($config | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'exec', 'tauri', 'build', '--target', 'x86_64-pc-windows-msvc', '--bundles', 'nsis', '--config', $generated)
    $version = (Get-Content desktop/package.json -Raw | ConvertFrom-Json).version
    $releaseRoot = Join-Path $repo 'desktop/src-tauri/target/x86_64-pc-windows-msvc/release'
    $exe = Join-Path $releaseRoot 'Zentra.exe'
    $setup = Join-Path $releaseRoot "bundle/nsis/Zentra_${version}_x64-setup.exe"
    foreach ($file in @($exe, $setup)) {
        if (-not (Test-Path $file -PathType Leaf) -or (Get-Item $file).Length -lt 1000000) { throw "Missing build artifact: $file" }
        Copy-Item -LiteralPath $file -Destination $artifacts
    }
    $source = (& git rev-parse HEAD).Trim()
    $proof = [ordered]@{
        version = $version; source = $source; target = 'x86_64-pc-windows-msvc'
        identifier = 'ch.helvichantier.desktop'; builtAt = [DateTimeOffset]::UtcNow.ToString('o')
        updaterEndpoint = $env:ELYKO_UPDATER_ENDPOINT; updaterPublicKey = $env:ELYKO_UPDATER_PUBLIC_KEY
        companyTestsPassed = $true; accountTestsPassed = $true; authenticodeSigned = $false
        files = @($exe, $setup | ForEach-Object { [ordered]@{name = (Split-Path $_ -Leaf); size = (Get-Item $_).Length; sha256 = (Get-FileHash $_ -Algorithm SHA256).Hash.ToLowerInvariant()} })
    }
    [IO.File]::WriteAllText((Join-Path $artifacts 'provenance.json'), ($proof | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
} finally {
    Stop-Transcript | Out-Null
}
