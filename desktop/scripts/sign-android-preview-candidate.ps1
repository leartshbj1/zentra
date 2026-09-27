#Requires -Version 7.0
param(
  [Parameter(Mandatory)][string]$Source,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedRevision,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{64}$')][string]$ExpectedSha256,
  [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [Parameter(Mandatory)][string]$Destination,
  [Parameter(Mandatory)][string]$Java,
  [Parameter(Mandatory)][string]$BuildTools,
  [Parameter(Mandatory)][string]$Python
)
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'The protected preview identity is available only on its Windows signing host'}
$sourcePath=(Resolve-Path -LiteralPath $Source).Path
$sourceFolder=Split-Path $sourcePath
if((Get-FileHash -LiteralPath $sourcePath).Hash.ToLowerInvariant() -ne $ExpectedSha256){throw 'Downloaded build hash mismatch'}
if((Get-Content -LiteralPath (Join-Path $sourceFolder 'SOURCE.txt') -Raw).Trim() -ne $ExpectedRevision){throw 'Downloaded build revision mismatch'}
$target=[IO.Path]::GetFullPath($Destination)
$receipt="$target.verification.json"
if((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath $receipt)){throw 'Refusing to replace an existing package or receipt'}
$pythonChecker=Join-Path $PSScriptRoot 'check-android-release.py'
$pythonVerifier=Join-Path $PSScriptRoot 'verify-android-preview.py'
$pin=(Get-Content -LiteralPath (Join-Path $PSScriptRoot '../android-preview-certificate.sha256') -Raw).Trim().ToLowerInvariant()
if($pin -notmatch '^[0-9a-f]{64}$'){throw 'Invalid pinned certificate'}
$staging=Join-Path ([IO.Path]::GetTempPath()) ('zentra-android-sign-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($staging) | Out-Null
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
Set-Acl -LiteralPath $staging -AclObject $acl
$keystore=Join-Path $staging 'preview.p12'
$certificate=Join-Path $staging 'preview.der'
$signed=Join-Path $staging 'signed.apk'
$proof=Join-Path $staging 'verification.json'
$manifestProof=Join-Path $staging 'manifest.json'
$previousPassword=$env:ZENTRA_ANDROID_PREVIEW_KEYSTORE_PASSWORD
$material=$null
$bytes=$null
$keyBytes=$null
try {
  & $Python $pythonChecker $sourcePath --aapt (Join-Path $BuildTools 'aapt.exe') --version $Version --source $ExpectedRevision --output $manifestProof | Out-Null
  if($LASTEXITCODE -ne 0){throw 'The unsigned candidate failed its manifest or native library checks'}
  & (Join-Path $BuildTools 'zipalign.exe') -c -P 16 4 $sourcePath
  if($LASTEXITCODE -ne 0){throw 'The unsigned candidate is not aligned'}
  $entropy=[Text.Encoding]::UTF8.GetBytes('Zentra Android preview signing identity v1')
  $protected=Join-Path $env:LOCALAPPDATA 'Zentra/release-signing/android-preview-signing.dpapi'
  $bytes=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($protected),$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $material=[Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
  if($material.certificateSha256 -ne $pin){throw 'Protected certificate mismatch; key rotation is forbidden'}
  $keyBytes=[Convert]::FromBase64String($material.keystore)
  [IO.File]::WriteAllBytes($keystore,$keyBytes)
  $env:ZENTRA_ANDROID_PREVIEW_KEYSTORE_PASSWORD=$material.password
  $keytool=Join-Path (Split-Path $Java) 'keytool.exe'
  & $keytool -exportcert -keystore $keystore -storetype PKCS12 -storepass:env ZENTRA_ANDROID_PREVIEW_KEYSTORE_PASSWORD -alias zentra-preview -file $certificate
  if($LASTEXITCODE -ne 0 -or (Get-FileHash -LiteralPath $certificate).Hash.ToLowerInvariant() -ne $pin){throw 'Keystore identity mismatch'}
  & $Java -jar (Join-Path $BuildTools 'lib/apksigner.jar') sign --ks $keystore --ks-type PKCS12 --ks-key-alias zentra-preview --ks-pass env:ZENTRA_ANDROID_PREVIEW_KEYSTORE_PASSWORD --key-pass env:ZENTRA_ANDROID_PREVIEW_KEYSTORE_PASSWORD --v4-signing-enabled false --out $signed $sourcePath
  if($LASTEXITCODE -ne 0){throw 'APK signing failed'}
  & $Python $pythonVerifier --unsigned $sourcePath --signed $signed --expected-sha256 $ExpectedSha256 --source $ExpectedRevision --version $Version --java $Java --build-tools $BuildTools --output $proof
  if($LASTEXITCODE -ne 0){throw 'Signed package verification failed'}
  # Publish locally only after checks; never modify the downloaded original.
  [IO.Directory]::CreateDirectory((Split-Path $target)) | Out-Null
  [IO.File]::Copy($signed,$target,$false)
  [IO.File]::Copy($proof,$receipt,$false)
} finally {
  if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}
  if($keyBytes){[Array]::Clear($keyBytes,0,$keyBytes.Length)}
  $material=$null
  $env:ZENTRA_ANDROID_PREVIEW_KEYSTORE_PASSWORD=$previousPassword
  # Delete only the explicitly generated files in this invocation's directory.
  foreach($path in @($keystore,$certificate,$signed,$proof,$manifestProof)) {
    if(Test-Path -LiteralPath $path){Remove-Item -LiteralPath $path -Force}
  }
  Remove-Item -LiteralPath $staging -Force
}
