Set-StrictMode -Version Latest
# Pure source/evidence checks. This helper never builds, runs a native harness,
# restores files, stages changes or cleans the repository.
$script:ZentraRecoveryGeneratedOutputs = @(
  'desktop/src-tauri/gen/schemas/acl-manifests.json',
  'desktop/src-tauri/gen/schemas/capabilities.json',
  'desktop/src-tauri/gen/schemas/desktop-schema.json',
  'desktop/src-tauri/gen/schemas/windows-schema.json'
)

function Assert-ZentraRecoverySourceCi {
  param([Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedSource)
  if ($env:CIRCLECI -cne 'true' -or $env:OS -cne 'Windows_NT') { throw 'Disposable Windows CircleCI runner required.' }
  if ($env:CIRCLE_SHA1 -cne $ExpectedSource) { throw 'Exact CircleCI revision required.' }
  if ($env:ZENTRA_VERIFY_DIAGNOSTICS_ONLY -cne 'true' -or $env:ZENTRA_VERIFY_ONLY -cne 'true') { throw 'Both existing verification-only guards are required.' }
  if ($env:RUSTUP_TOOLCHAIN -cne 'stable-x86_64-pc-windows-msvc') { throw 'The installed MSVC toolchain is required.' }
  if (-not [string]::IsNullOrEmpty($env:CARGO_TARGET_DIR)) { throw 'The existing harness requires its exact repository target directory.' }
}

function Invoke-ZentraRecoveryGit {
  param([string]$Repository, [string]$Arguments)
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = 'git'
  $start.Arguments = '-C "' + $Repository + '" ' + $Arguments
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false, $true)
  $start.EnvironmentVariables['GIT_OPTIONAL_LOCKS'] = '0'
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  try {
    if (-not $process.Start()) { throw 'Git source inspection did not start.' }
    $output = $process.StandardOutput.ReadToEnd()
    $errorText = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw ('Git source inspection failed: ' + $errorText) }
    return $output
  } finally { $process.Dispose() }
}

function Get-ZentraRecoveryTextHash {
  param([string]$Text)
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose() }
}

function Get-ZentraRecoveryBytesHash {
  param([byte[]]$Bytes)
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($hash.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose() }
}

function Assert-ZentraRecoverySnapshotFile {
  param([string]$Path)
  $full = [IO.Path]::GetFullPath($Path)
  $cursor = $full
  while (-not [string]::IsNullOrEmpty($cursor)) {
    $item = Get-Item -Force -LiteralPath $cursor -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse snapshot or ancestor refused.' }
    if ($cursor -ceq $full -and $item.PSIsContainer) { throw 'Snapshot must be an ordinary file.' }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
  return (Get-Item -Force -LiteralPath $full -ErrorAction Stop)
}

function Assert-ZentraRecoveryRegularPath {
  param([string]$Repository, [string]$RelativePath)
  $root = [IO.Path]::GetFullPath($Repository).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $path = [IO.Path]::GetFullPath((Join-Path $root $RelativePath))
  if (-not $path.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Input path escaped the reviewed repository.' }
  $cursor = $path
  while ($cursor.Length -ge $root.Length) {
    $item = Get-Item -Force -LiteralPath $cursor -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse input or ancestor refused.' }
    if ($cursor -ceq $path -and $item.PSIsContainer) { throw 'Input must be an ordinary file.' }
    if ($cursor -ceq $root) { break }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
  return $path
}

function Get-ZentraRecoverySourceState {
  param([string]$Repository)
  $head = (Invoke-ZentraRecoveryGit $Repository 'rev-parse HEAD').Trim()
  $status = Invoke-ZentraRecoveryGit $Repository 'status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none'
  $index = Invoke-ZentraRecoveryGit $Repository 'ls-files --stage -z'
  $flags = Invoke-ZentraRecoveryGit $Repository 'ls-files -v -z'
  $errors = @()
  $entries = @()
  $parts = $status.Split([char]0)
  for ($i=0; $i -lt $parts.Length; $i++) {
    if ($parts[$i].Length -eq 0) { continue }
    if ($parts[$i].Length -lt 4 -or $parts[$i][2] -cne ' ') { throw 'Malformed Git status refused.' }
    $entry = [ordered]@{ status=$parts[$i].Substring(0,2); path=$parts[$i].Substring(3); previousPath=$null }
    if ($entry.status.Contains('R') -or $entry.status.Contains('C')) {
      $i++
      if ($i -ge $parts.Length -or $parts[$i].Length -eq 0) { throw 'Malformed rename status refused.' }
      $entry.previousPath = $parts[$i]
    }
    $entries += [pscustomobject]$entry
  }
  foreach ($flag in $flags.Split([char]0)) {
    if ($flag.Length -gt 0 -and (-not $flag.StartsWith('H ', [StringComparison]::Ordinal))) { $errors += 'Hidden, skipped or non-ordinary index input: ' + $flag }
  }
  $files = @()
  foreach ($record in $index.Split([char]0)) {
    if ($record.Length -eq 0) { continue }
    $match = [regex]::Match($record, '^(?<mode>[0-9]{6}) (?<blob>[0-9a-f]{40}) (?<stage>[0-3])\t(?<path>[\s\S]+)$')
    if (-not $match.Success) { throw 'Malformed tracked input refused.' }
    $relative = $match.Groups['path'].Value
    $file = [ordered]@{ path=$relative; mode=$match.Groups['mode'].Value; blob=$match.Groups['blob'].Value; stage=$match.Groups['stage'].Value; sha256=$null; generated=($script:ZentraRecoveryGeneratedOutputs -ccontains $relative); error=$null }
    try {
      if ($file.stage -cne '0' -or $file.mode -cnotin @('100644','100755')) { throw 'Only ordinary stage-zero tracked inputs are admitted.' }
      $path = Assert-ZentraRecoveryRegularPath $Repository $relative
      $file.sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
      if ($file.generated) {
        $json = [Text.UTF8Encoding]::new($false, $true).GetString([IO.File]::ReadAllBytes($path)).TrimStart([char]0xfeff)
        $null = ConvertFrom-Json -InputObject $json -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($json)) { throw 'Generated output is not JSON.' }
      }
    } catch { $file.error = 'Tracked input validation failed: ' + [string]$_; $errors += $relative + ': ' + $file.error }
    $files += [pscustomobject]$file
  }
  foreach ($allowed in $script:ZentraRecoveryGeneratedOutputs) {
    if (@($files | Where-Object { $_.path -ceq $allowed }).Count -ne 1) { $errors += 'Required generated output is not tracked exactly once: ' + $allowed }
  }
  if ((Invoke-ZentraRecoveryGit $Repository 'rev-parse HEAD').Trim() -cne $head -or
      (Invoke-ZentraRecoveryGit $Repository 'status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none') -cne $status -or
      (Invoke-ZentraRecoveryGit $Repository 'ls-files --stage -z') -cne $index -or
      (Invoke-ZentraRecoveryGit $Repository 'ls-files -v -z') -cne $flags) { $errors += 'Source changed during integrity capture.' }
  return [pscustomobject][ordered]@{ head=$head; status=$entries; rawStatus=$status; indexSha256=(Get-ZentraRecoveryTextHash $index); flagsSha256=(Get-ZentraRecoveryTextHash $flags); files=$files; errors=$errors }
}

function Write-ZentraRecoveryEvidence {
  param([string]$Path, [string]$Text)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $bytes=[Text.UTF8Encoding]::new($false).GetBytes($Text); $stream.Write($bytes,0,$bytes.Length) }
  finally { $stream.Dispose() }
}

function New-ZentraRecoverySourceSnapshot {
  param([string]$Repository, [ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedSource, [string]$EvidenceDirectory)
  $repo = (Resolve-Path -LiteralPath $Repository).Path
  [IO.Directory]::CreateDirectory($EvidenceDirectory) | Out-Null
  $snapshotPath = Join-Path $EvidenceDirectory 'before-build.json'
  if (Test-Path -LiteralPath $snapshotPath) { throw 'Source snapshot already exists; never overwrite evidence.' }
  $snapshot = [ordered]@{ schemaVersion=1; repository=$repo; expectedSource=$ExpectedSource; generatedOutputs=$script:ZentraRecoveryGeneratedOutputs; capturedAt=[DateTimeOffset]::UtcNow.ToString('o'); passed=$false; source=$null; errors=@() }
  try {
    $snapshot.source = Get-ZentraRecoverySourceState $repo
    $snapshot.errors = @($snapshot.source.errors)
    if ($snapshot.source.head -cne $ExpectedSource) { $snapshot.errors += 'Repository HEAD differs from the reviewed source.' }
    if ($snapshot.source.rawStatus.Length -ne 0) { $snapshot.errors += 'The complete repository must be clean before any build.' }
    $snapshot.passed = $snapshot.errors.Count -eq 0
  } catch { $snapshot.errors += [string]$_ }
  Write-ZentraRecoveryEvidence $snapshotPath ($snapshot | ConvertTo-Json -Depth 12)
  if (-not $snapshot.passed) { throw 'Pre-build source integrity refused; before-build.json retains status, hashes and reasons.' }
  return [pscustomobject]@{ path=$snapshotPath; sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $snapshotPath).Hash.ToLowerInvariant() }
}

function Assert-ZentraRecoverySourceSnapshot {
  param([string]$Repository, [ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedSource,
    [string]$SnapshotPath, [ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedSnapshotSha256,
    [string]$EvidenceDirectory, [ValidatePattern('^[a-z][a-z0-9-]{0,63}$')][string]$Stage)
  $repo = (Resolve-Path -LiteralPath $Repository).Path
  [IO.Directory]::CreateDirectory($EvidenceDirectory) | Out-Null
  $reportPath = Join-Path $EvidenceDirectory ($Stage + '.json')
  $diffPath = Join-Path $EvidenceDirectory ($Stage + '-generated.patch')
  if ((Test-Path -LiteralPath $reportPath) -or (Test-Path -LiteralPath $diffPath)) { throw 'Integrity evidence already exists; never overwrite it.' }
  $report = [ordered]@{ schemaVersion=1; stage=$Stage; expectedSource=$ExpectedSource; expectedSnapshotSha256=$ExpectedSnapshotSha256; actualSnapshotSha256=$null; finalSnapshotSha256=$null; snapshotIdentityBefore=$null; snapshotIdentityAfter=$null; capturedAt=[DateTimeOffset]::UtcNow.ToString('o'); passed=$false; source=$null; generatedDifferences=@(); errors=@() }
  $snapshotStream=$null
  try {
    $snapshotFile=Assert-ZentraRecoverySnapshotFile $SnapshotPath
    $report.snapshotIdentityBefore=[pscustomobject]@{path=$snapshotFile.FullName;creationTicks=$snapshotFile.CreationTimeUtc.Ticks;writeTicks=$snapshotFile.LastWriteTimeUtc.Ticks;length=$snapshotFile.Length}
    # Keep the ordinary snapshot open without write/delete sharing. Hash and
    # parse the same single captured byte array, never reopen it for parsing.
    $snapshotStream=[IO.File]::Open($snapshotFile.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $memory=[IO.MemoryStream]::new()
    try { $snapshotStream.CopyTo($memory); $snapshotBytes=$memory.ToArray() }
    finally { $memory.Dispose() }
    $report.actualSnapshotSha256 = Get-ZentraRecoveryBytesHash $snapshotBytes
    $before = [Text.UTF8Encoding]::new($false,$true).GetString($snapshotBytes) | ConvertFrom-Json
    $report.source = Get-ZentraRecoverySourceState $repo
    $report.errors = @($report.source.errors)
    if ($report.actualSnapshotSha256 -cne $ExpectedSnapshotSha256) { throw 'Pre-build snapshot hash changed.' }
    if ($before.schemaVersion -ne 1 -or -not $before.passed -or $before.repository -cne $repo -or $before.expectedSource -cne $ExpectedSource -or $before.source.head -cne $ExpectedSource) { throw 'Pre-build snapshot is not the admitted exact repository source.' }
    if ($report.source.head -cne $ExpectedSource) { $report.errors += 'Repository HEAD changed after build.' }
    if ($report.source.indexSha256 -cne $before.source.indexSha256 -or $report.source.flagsSha256 -cne $before.source.flagsSha256) { $report.errors += 'The tracked index or input flags changed after build.' }
    foreach ($entry in $report.source.status) {
      if ($entry.status -cne ' M' -or $script:ZentraRecoveryGeneratedOutputs -cnotcontains $entry.path -or $null -ne $entry.previousPath) { $report.errors += 'Unauthorized Git change: ' + $entry.status + ' ' + $entry.path }
    }
    $previous = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    foreach ($file in $before.source.files) { $previous.Add($file.path, $file) }
    foreach ($file in $report.source.files) {
      if (-not $previous.ContainsKey($file.path)) { $report.errors += 'New tracked input after build: ' + $file.path; continue }
      if ($file.sha256 -cne $previous[$file.path].sha256) {
        if ($script:ZentraRecoveryGeneratedOutputs -ccontains $file.path) { $report.generatedDifferences += [pscustomobject]@{ path=$file.path; beforeSha256=$previous[$file.path].sha256; afterSha256=$file.sha256 } }
        else { $report.errors += 'Immutable input hash changed: ' + $file.path }
      }
      $previous.Remove($file.path) | Out-Null
    }
    foreach ($missing in $previous.Keys) { $report.errors += 'Tracked input disappeared after build: ' + $missing }
    $report.passed = $report.errors.Count -eq 0
  } catch { $report.errors += [string]$_; $report.passed=$false }
  finally {
    if ($null -ne $snapshotStream) {
      try {
        $finalFile=Assert-ZentraRecoverySnapshotFile $SnapshotPath
        $report.snapshotIdentityAfter=[pscustomobject]@{path=$finalFile.FullName;creationTicks=$finalFile.CreationTimeUtc.Ticks;writeTicks=$finalFile.LastWriteTimeUtc.Ticks;length=$finalFile.Length}
        $report.finalSnapshotSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $SnapshotPath).Hash.ToLowerInvariant()
        if ($report.finalSnapshotSha256 -cne $ExpectedSnapshotSha256 -or $finalFile.FullName -cne $report.snapshotIdentityBefore.path -or $finalFile.CreationTimeUtc.Ticks -ne $report.snapshotIdentityBefore.creationTicks -or $finalFile.LastWriteTimeUtc.Ticks -ne $report.snapshotIdentityBefore.writeTicks -or $finalFile.Length -ne $report.snapshotIdentityBefore.length) { throw 'Snapshot identity or hash changed during integrity capture.' }
      } catch { $report.errors += [string]$_; $report.passed=$false }
      finally { $snapshotStream.Dispose() }
    }
  }
  try {
    $paths = $script:ZentraRecoveryGeneratedOutputs | ForEach-Object { '"' + $_ + '"' }
    $diff = Invoke-ZentraRecoveryGit $repo ('diff --no-ext-diff --no-textconv -- ' + ($paths -join ' '))
    Write-ZentraRecoveryEvidence $diffPath $diff
  } catch { $report.errors += 'Generated difference capture failed: ' + [string]$_; $report.passed=$false }
  Write-ZentraRecoveryEvidence $reportPath ($report | ConvertTo-Json -Depth 12)
  if (-not $report.passed) { throw ('Post-build source integrity refused; ' + $Stage + '.json retains status, hashes and reasons.') }
}
