[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# CI control only. Product scripts, tests and the harness run from this exact SHA.
$appSource = '0d2571a741883add178b485e8a1ad4d0222d4204'
$releaseVersion = '1.90.15'
$releaseBranch = 'codex/release-1.90.15-windows-large-20261006'

function Assert-Windows1915Verifier {
    param([string]$Branch, [string]$PipelineSource, [string]$Head,
        [string]$ApplicationSource, [string]$CircleCI, [string]$OperatingSystem,
        [string]$JobName, [string]$BuildNumber, [string[]]$ChangedPaths,
        [string[]]$DirtyPaths, [string[]]$ActiveVerificationFlags)
    if ($Branch -cne 'codex/release-1.90.15-windows-large-20261006' -or
        $ApplicationSource -cne '0d2571a741883add178b485e8a1ad4d0222d4204' -or
        $CircleCI -cne 'true' -or $OperatingSystem -cne 'Windows_NT' -or
        $JobName -cne 'windows-release-1915-large' -or $BuildNumber -cnotmatch '^[1-9][0-9]*$') {
        throw 'Windows 1.90.15 Large requires its exact opt-in branch, job and application source.'
    }
    if ($PipelineSource -cnotmatch '^[0-9a-f]{40}$' -or $PipelineSource -ceq $ApplicationSource -or $Head -cne $PipelineSource) {
        throw 'The verifier must be the actual, distinct CircleCI pipeline revision.'
    }
    if (@($DirtyPaths | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count -ne 0 -or
        @($ActiveVerificationFlags).Count -ne 0) {
        throw 'Refusing modified verifier controls or a reduced verification mode.'
    }
    $allowed = @('.circleci/config.yml', '.circleci/windows1915-controller.ps1')
    $actual = @($ChangedPaths | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($actual.Count -ne 2 -or @($actual | Sort-Object -Unique).Count -ne 2 -or
        @($actual | Where-Object { $_ -cnotin $allowed }).Count -ne 0) {
        throw 'The new verifier must change exactly its two reviewed CI control files.'
    }
}

function Assert-Windows1915Versions {
    param([string]$PackageJson, [string]$TauriJson, [string]$CargoToml, [string]$CargoLock)
    if (($PackageJson | ConvertFrom-Json).version -cne '1.90.15' -or
        ($TauriJson | ConvertFrom-Json).version -cne '1.90.15') {
        throw 'Frozen Windows JSON metadata does not identify version 1.90.15.'
    }
    foreach ($item in @(@($CargoToml, '\[package\]'), @($CargoLock, '\[\[package\]\]'))) {
        $matches = [regex]::Matches($item[0], $item[1] + '\r?\nname = "helvichantier"\r?\nversion = "([^"]+)"')
        if ($matches.Count -ne 1 -or $matches[0].Groups[1].Value -cne '1.90.15') {
            throw 'Frozen Windows Rust metadata does not identify version 1.90.15.'
        }
    }
}

function Assert-Windows1915BuildProof {
    param($Proof)
    if ($Proof.source -cne '0d2571a741883add178b485e8a1ad4d0222d4204' -or
        $Proof.version -cne '1.90.15' -or $Proof.target -cne 'x86_64-pc-windows-msvc' -or
        $Proof.identifier -cne 'ch.helvichantier.desktop' -or
        $Proof.authenticodeSigned -isnot [bool] -or $Proof.authenticodeSigned) {
        throw 'The installer proof differs from the frozen unsigned MSVC release.'
    }
    foreach ($name in @('companyTestsPassed','accountTestsPassed','documentCompositionTestsPassed',
        'documentEditorTestsPassed','bexioImportTestsPassed','catalogImportTestsPassed','outgoingMailTestsPassed',
        'fixedAssetsTestsPassed','inputVatTestsPassed','invoiceScanTestsPassed','interfaceWorkspaceTestsPassed')) {
        if ($Proof.$name -isnot [bool] -or -not $Proof.$name) { throw "Missing successful release proof: $name" }
    }
    $expected = @('Zentra.exe', 'Zentra_1.90.15_x64-setup.exe')
    $files = @($Proof.files)
    if ($files.Count -ne 2 -or @($files.name | Sort-Object -Unique).Count -ne 2 -or
        @($files | Where-Object { $_.name -cnotin $expected }).Count -ne 0) {
        throw 'The release proof must contain exactly the new executable and NSIS installer.'
    }
    foreach ($file in $files) {
        if ($file.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
            ($file.size -isnot [long] -and $file.size -isnot [int]) -or $file.size -lt 1000000) {
            throw 'Invalid installer hash or size in release proof.'
        }
    }
}

function Invoke-Windows1915Git {
    param([string[]]$Arguments)
    $lines = @(& git @Arguments)
    if ($LASTEXITCODE -ne 0) { throw "Git failed while checking Windows CI provenance ($LASTEXITCODE)." }
    return $lines
}

function Assert-Windows1915PayloadBytes {
    param([string]$Root, $Proof)
    Assert-Windows1915BuildProof $Proof
    foreach ($file in @($Proof.files)) {
        $path = Join-Path $Root $file.name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
            (Get-Item -LiteralPath $path).Length -ne $file.size -or
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256) {
            throw 'The actual new installer bytes do not match their release proof.'
        }
    }
}

function Write-Windows1915SourceReceipts {
    param([string]$Root, [string]$PipelineSource)
    $source = '0d2571a741883add178b485e8a1ad4d0222d4204'
    if ($PipelineSource -cnotmatch '^[0-9a-f]{40}$' -or $PipelineSource -ceq $source) {
        throw 'Refusing a placeholder or application SHA as verifier receipt.'
    }
    [IO.File]::WriteAllText((Join-Path $Root 'SOURCE.txt'), "$source`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $Root 'VERIFIER-SOURCE.txt'), "$PipelineSource`n", [Text.UTF8Encoding]::new($false))
    return @('SOURCE.txt','VERIFIER-SOURCE.txt') | ForEach-Object {
        $path = Join-Path $Root $_
        [ordered]@{name=$_;size=(Get-Item -LiteralPath $path).Length;
            sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
}

function Assert-Windows1915Application {
    param([string]$Root)
    $head = @(Invoke-Windows1915Git @('-C',$Root,'rev-parse','HEAD'))
    if ($head.Count -ne 1 -or $head[0] -cne $appSource) { throw 'Application checkout does not equal the frozen release source.' }
    $branch = @(& git -C $Root symbolic-ref --quiet HEAD)
    if ($LASTEXITCODE -ne 1 -or $branch.Count -ne 0) { throw 'The application checkout must be detached.' }
    $dirty = @(Invoke-Windows1915Git @('-C',$Root,'diff','--name-only','HEAD'))
    if ($dirty.Count -ne 0) { throw 'Tracked frozen application files changed.' }
    Assert-Windows1915Versions (Get-Content -LiteralPath "$Root/desktop/package.json" -Raw) `
        (Get-Content -LiteralPath "$Root/desktop/src-tauri/tauri.conf.json" -Raw) `
        (Get-Content -LiteralPath "$Root/desktop/src-tauri/Cargo.toml" -Raw) `
        (Get-Content -LiteralPath "$Root/desktop/src-tauri/Cargo.lock" -Raw)
}

$verifierRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$applicationRoot = Join-Path $verifierRoot '.zentra-windows-source'
$pipelineSource = $env:CIRCLE_SHA1
$head = @(Invoke-Windows1915Git @('-C',$verifierRoot,'rev-parse','HEAD'))
if ($head.Count -ne 1) { throw 'Cannot identify the verifier checkout.' }
& git -C $verifierRoot cat-file -e "$appSource^{commit}"
if ($LASTEXITCODE -ne 0) {
    Invoke-Windows1915Git @('-C',$verifierRoot,'fetch','--depth','1','origin',$appSource) | Out-Host
}
$changed = @(Invoke-Windows1915Git @('-C',$verifierRoot,'diff','--name-only',$appSource,$pipelineSource))
$dirty = @(Invoke-Windows1915Git @('-C',$verifierRoot,'status','--porcelain','--untracked-files=all','--','.circleci'))
$activeFlags = @('ZENTRA_VERIFY_DIAGNOSTICS_ONLY','ZENTRA_VERIFY_ONLY','ZENTRA_VERIFY_PDF_ONLY',
    'ZENTRA_VERIFY_UPDATER_ONLY','ZENTRA_VERIFY_BACKUP_ONLY','ZENTRA_VERIFY_REPORTS_ONLY') | Where-Object {
    $value = [Environment]::GetEnvironmentVariable($_,'Process')
    -not [string]::IsNullOrEmpty($value) -and $value -cne 'false'
}
Assert-Windows1915Verifier $env:CIRCLE_BRANCH $pipelineSource $head[0] $env:ZENTRA_WINDOWS_SOURCE_REVISION `
    $env:CIRCLECI $env:OS $env:CIRCLE_JOB $env:CIRCLE_BUILD_NUM $changed $dirty @($activeFlags)
if ($env:ZENTRA_RELEASE_TEST_HARNESS -cne 'true' -or $env:RUSTUP_TOOLCHAIN -cne 'stable-x86_64-pc-windows-msvc') {
    throw 'The complete original release harness and MSVC toolchain are required.'
}
if (Test-Path -LiteralPath $applicationRoot) { throw 'Refusing an inherited application checkout or build outputs.' }
Invoke-Windows1915Git @('init',$applicationRoot) | Out-Host
Invoke-Windows1915Git @('-C',$applicationRoot,'remote','add','origin','https://github.com/leartshbj1/zentra.git') | Out-Host
Invoke-Windows1915Git @('-C',$applicationRoot,'fetch','--depth','1','origin',$appSource) | Out-Host
Invoke-Windows1915Git @('-C',$applicationRoot,'checkout','--detach','FETCH_HEAD') | Out-Host
Assert-Windows1915Application $applicationRoot
$startedAt = [DateTimeOffset]::UtcNow.ToString('o')
try {
    # Existing harness requires Circle source == application HEAD. Keep the real
    # pipeline revision independently and restore it even if any original test fails.
    $env:CIRCLE_SHA1 = $appSource
    & (Join-Path $applicationRoot 'desktop/scripts/cloud-release-windows.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'The original full Windows release command failed.' }
} finally {
    $env:CIRCLE_SHA1 = $pipelineSource
}
Assert-Windows1915Application $applicationRoot
# These two regression suites must pass on the frozen product before completion receipts.
& pnpm.cmd --dir (Join-Path $applicationRoot 'desktop') exec vitest run src/automationSourceMessage.test.tsx src/SetupReadinessCenter.test.tsx
if ($LASTEXITCODE -ne 0) { throw 'The additional 1.90.15 navigation UI regressions failed.' }
Assert-Windows1915Application $applicationRoot
$artifacts = Join-Path $applicationRoot 'desktop/artifacts/windows'
$proof = Get-Content -LiteralPath (Join-Path $artifacts 'provenance.json') -Raw | ConvertFrom-Json
Assert-Windows1915PayloadBytes $artifacts $proof
# These receipts are emitted only after all original checks and real packaging.
$receiptFiles = @(Write-Windows1915SourceReceipts $artifacts $pipelineSource)
$controlProof = [ordered]@{
    source=$appSource;pipelineSource=$pipelineSource;buildJob=[int]$env:CIRCLE_BUILD_NUM
    version=$releaseVersion;target='x86_64-pc-windows-msvc';applicationCheckoutDetached=$true
    originalReleaseCommand='desktop/scripts/cloud-release-windows.ps1';fullOriginalReleaseCompleted=$true;additionalNavigationUiTestsPassed=$true
    additionalNavigationUiTestFiles=@('src/automationSourceMessage.test.tsx','src/SetupReadinessCenter.test.tsx')
    startedAt=$startedAt;completedAt=[DateTimeOffset]::UtcNow.ToString('o')
    receiptFiles=@($receiptFiles);payloadFiles=@($proof.files);publishesRelease=$false
}
[IO.File]::WriteAllText((Join-Path $artifacts 'windows-ci-proof.json'),
    ($controlProof | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
Write-Host "Windows 1.90.15 complete: application $appSource; verifier $pipelineSource; job $env:CIRCLE_BUILD_NUM."
