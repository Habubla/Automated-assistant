$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-settings.ps1')
$cli = Join-Path $project 'automation\n8n\runtime\node_modules\n8n\bin\n8n'
if (-not (Test-Path -LiteralPath $cli)) { throw 'Install the pinned local n8n runtime first.' }
$credentialFile = Join-Path $project '.local\n8n-import-credentials.json'
$credentials = @(
  @{ id='june-memory-worker';name='June Memory worker (local)';type='httpHeaderAuth';data=@{name='Authorization';value=('Bearer '+$secrets.worker)} },
  @{ id='june-webhook-header';name='June inbound webhook';type='httpHeaderAuth';data=@{name='X-June-Webhook-Key';value=$secrets.webhook} }
)
$credentials | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $credentialFile
& icacls.exe $credentialFile /inheritance:r /grant:r "${identity}:(F)" 'SYSTEM:(F)' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not protect import credentials.' }
Remove-Item Env:JUNE_REVIEW_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:JUNE_READER_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:JUNE_WORKER_TOKEN -ErrorAction SilentlyContinue
& node $cli import:credentials --input $credentialFile
if ($LASTEXITCODE -ne 0) { throw 'Credential import failed.' }
& node $cli import:workflow --separate --input (Join-Path $project 'automation\n8n\workflows')
if ($LASTEXITCODE -ne 0) { throw 'Workflow import failed.' }
# This is a single known temporary file; no recursive cleanup or retention deletion.
Remove-Item -LiteralPath $credentialFile
Write-Output 'Local n8n credentials and five inactive workflows are prepared. No service or schedule was started.'
