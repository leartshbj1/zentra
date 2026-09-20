$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskNode = Join-Path $taskRoot 'runtime/node.exe'
$taskServer = Join-Path $PSScriptRoot 'server.mjs'
Start-Process -FilePath $taskNode -ArgumentList ('"'+$taskServer+'"') -WorkingDirectory $taskRoot -WindowStyle Hidden
