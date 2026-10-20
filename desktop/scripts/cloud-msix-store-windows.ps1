[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ReleaseTag,
    [switch]$WithUpdaterTests
)
# Microsoft Store package, kept out of the Windows release job: takes the
# Zentra.exe of an already published GitHub release, checks it, and wraps it
# in an MSIX with package-msix-windows.ps1. With -WithUpdaterTests it also
# compiles the Rust library and runs app_updater::tests, which hold the
# "closed inside a package" rule. Nothing is signed or published here.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:CIRCLECI -cne 'true') { throw 'This check runs on CircleCI only.' }
$tagMatch = [regex]::Match($ReleaseTag, '^v(\d{1,5}\.\d{1,5}\.\d{1,5})$')
if (-not $tagMatch.Success) { throw "Release tag must look like v1.90.41, got '$ReleaseTag'" }
$version = $tagMatch.Groups[1].Value
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $repo
$artifacts = Join-Path $repo 'desktop/artifacts/msix'
[IO.Directory]::CreateDirectory($artifacts) | Out-Null
$work = Join-Path $env:TEMP 'zentra-msix-store'
[IO.Directory]::CreateDirectory($work) | Out-Null
$timings = [ordered]@{}
$clock = [Diagnostics.Stopwatch]::StartNew()

function Invoke-Checked {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed ($LASTEXITCODE)" }
}

function Complete-Phase {
    param([string]$Name)
    $timings[$Name] = [math]::Round($clock.Elapsed.TotalSeconds)
    Write-Host "== $Name done after $($timings[$Name]) s"
}

Start-Transcript -Path (Join-Path $artifacts 'msix-store.log') | Out-Null
try {
    # 1. The installer exactly as published, checked against GitHub's digest.
    $release = Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/leartshbj1/zentra/releases/tags/$ReleaseTag"
    $assetName = "Zentra_${version}_x64-setup.exe"
    $asset = @($release.assets | Where-Object { $_.name -ceq $assetName })
    if ($asset.Count -ne 1) { throw "Release $ReleaseTag has no $assetName" }
    $setup = Join-Path $work $assetName
    Invoke-WebRequest -UseBasicParsing $asset[0].browser_download_url -OutFile $setup
    $setupSha256 = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($asset[0].PSObject.Properties['digest'] -and $asset[0].digest) {
        if ($asset[0].digest -cne "sha256:$setupSha256") { throw "Installer digest differs from GitHub: $($asset[0].digest)" }
    } else {
        Write-Host "GitHub gives no digest for $assetName; sha256 $setupSha256 is recorded only."
    }

    # 2. Zentra.exe out of the NSIS installer, without running it.
    $sevenZip = @("$env:ProgramFiles\7-Zip\7z.exe", "$env:ProgramData\chocolatey\bin\7z.exe") |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $sevenZip) {
        Invoke-Checked choco @('install', '7zip.portable', '--yes', '--no-progress')
        $sevenZip = "$env:ProgramData\chocolatey\bin\7z.exe"
    }
    $extracted = Join-Path $work 'installer'
    Invoke-Checked $sevenZip @('x', '-y', "-o$extracted", $setup)
    $exe = Join-Path $extracted 'Zentra.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or (Get-Item -LiteralPath $exe).Length -lt 1000000) { throw 'Zentra.exe was not found in the installer.' }
    $productVersion = (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion
    if (-not $productVersion -or -not $productVersion.StartsWith($version)) { throw "Zentra.exe reports version '$productVersion', expected $version" }

    # 3. The MSIX itself.
    $msix = & (Join-Path $PSScriptRoot 'package-msix-windows.ps1') -Executable $exe -Version $version -OutputDirectory $artifacts
    Complete-Phase 'msix'

    if ($WithUpdaterTests) {
        $toolsRoot = Join-Path $work 'tools'
        [IO.Directory]::CreateDirectory($toolsRoot) | Out-Null
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
        # Tauri's context macro embeds desktop/dist, so the web build comes first.
        Invoke-Checked pnpm.cmd @('--dir', 'desktop', 'build:web')
        Complete-Phase 'toolchain-and-web'

        $manifest = 'desktop/src-tauri/Cargo.toml'
        $build = @(& cargo test --locked --manifest-path $manifest --lib --no-run --message-format=json)
        if ($LASTEXITCODE -ne 0) { throw "cargo test --no-run failed ($LASTEXITCODE)" }
        Complete-Phase 'rust-test-compile'
        $executable = $null
        foreach ($line in $build) {
            if ($line -notmatch '"executable":"') { continue }
            $message = $line | ConvertFrom-Json
            if ($message.reason -eq 'compiler-artifact' -and $message.executable -and $message.profile.test -and ($message.target.kind -contains 'lib' -or $message.target.kind -contains 'cdylib' -or $message.target.kind -contains 'staticlib')) { $executable = $message.executable }
        }
        if (-not $executable) { throw 'Test executable not found.' }
        # Same Common-Controls v6 manifest as the ERP check: without it the Tauri
        # test binary stops with STATUS_ENTRYPOINT_NOT_FOUND.
        $mt = Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter mt.exe -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match '\\x64\\mt\.exe$' } | Sort-Object FullName -Descending | Select-Object -First 1
        if (-not $mt) { throw 'mt.exe not found.' }
        $manifestPath = Join-Path $work 'test-harness.manifest'
        [IO.File]::WriteAllText($manifestPath, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/></dependentAssembly></dependency></assembly>', [Text.UTF8Encoding]::new($false))
        Invoke-Checked $mt.FullName @('-nologo', '-manifest', $manifestPath, "-outputresource:$executable;#1")
        Push-Location (Join-Path $repo 'desktop/src-tauri')
        try { Invoke-Checked $executable @('app_updater::tests', '--test-threads=1') } finally { Pop-Location }
        Complete-Phase 'rust-updater-tests'
    }

    $summary = [ordered]@{
        source = (& git rev-parse HEAD).Trim()
        releaseTag = $ReleaseTag
        installer = [ordered]@{ name = $assetName; sha256 = $setupSha256 }
        executable = [ordered]@{ productVersion = $productVersion; sha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() }
        msix = [ordered]@{ name = $msix.name; size = $msix.size; sha256 = $msix.sha256; identityName = $msix.identityName; publisher = $msix.publisher; packageVersion = $msix.packageVersion; storeReady = $msix.storeReady }
        updaterTestsRun = [bool]$WithUpdaterTests
        secondsAfterStart = $timings
        circleJob = $env:CIRCLE_JOB
        circleBuildNum = $env:CIRCLE_BUILD_NUM
    }
    [IO.File]::WriteAllText((Join-Path $artifacts 'msix-store.public.json'), ($summary | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
} finally {
    Stop-Transcript | Out-Null
}
