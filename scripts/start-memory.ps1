$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-settings.ps1')
# Manual foreground launch only. Ctrl+C stops it; no startup task is registered.
& node (Join-Path $project 'src\server.js')
