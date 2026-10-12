$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\scripts\local-settings.ps1')
# The reviewer credential is deliberately removed from the n8n child environment.
Remove-Item Env:JUNE_REVIEW_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:JUNE_READER_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:JUNE_WORKER_TOKEN -ErrorAction SilentlyContinue
& node (Join-Path $PSScriptRoot 'runtime\node_modules\n8n\bin\n8n') start
