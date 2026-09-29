[CmdletBinding()]
param([ValidateSet('strict','nested-breakaway')][string]$JobLayout='strict')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:CIRCLECI -ne 'true') { throw 'This recipe requires the disposable CI Windows runner' }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $repo
$out = Join-Path $repo 'desktop/artifacts/windows-volume'
if (Test-Path -LiteralPath $out) { throw 'Volume output already exists; do not overwrite evidence' }
[IO.Directory]::CreateDirectory($out) | Out-Null
$toolsRoot = Join-Path $env:TEMP ('zentra-volume-node-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($toolsRoot) | Out-Null

# Private vendor runtime, no machine-wide installation. Record the exact version
# and vendor-checked zip hash; the Python worker probes its real capabilities.
$nodeBase = 'https://nodejs.org/dist/latest-v22.x'
$sums = (Invoke-WebRequest -UseBasicParsing "$nodeBase/SHASUMS256.txt" -TimeoutSec 30).Content
if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
$match = [regex]::Match([string]$sums, '(?m)^([a-f0-9]{64})\s+(node-v22\.[0-9]+\.[0-9]+-win-x64\.zip)\s*$')
if (-not $match.Success) { throw 'Node 22 vendor checksum not found' }
$zipName = $match.Groups[2].Value
$zipPath = Join-Path $toolsRoot $zipName
Invoke-WebRequest -UseBasicParsing "$nodeBase/$zipName" -OutFile $zipPath -TimeoutSec 120
$zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($zipHash -ne $match.Groups[1].Value) { throw 'Node checksum mismatch' }
Expand-Archive -LiteralPath $zipPath -DestinationPath $toolsRoot
$node = Join-Path (Join-Path $toolsRoot ([IO.Path]::GetFileNameWithoutExtension($zipName))) 'node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Verified Node executable missing' }
$runtime = [ordered]@{ archive=$zipName; sha256=$zipHash; vendor=$nodeBase; source=$env:CIRCLE_SHA1 }
[IO.File]::WriteAllText((Join-Path $out 'runtime-download.json'), ($runtime | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
& python desktop/scripts/windows-package-volume.py --job 181 --source 01ad1279b934113006398504163f309948d92e07 --schema 60 --output (Join-Path $out 'measurement') --node $node --job-layout $JobLayout --disposable-runner
# Preserve partial/unmeasured status 2; it is not a performance success.
exit $LASTEXITCODE
