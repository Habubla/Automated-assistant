$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$secretsFile = Join-Path $project '.local\service-secrets.json'
function New-JuneToken {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}
if (-not (Test-Path -LiteralPath $secretsFile)) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $secretsFile) | Out-Null
  $secrets = @{ worker=(New-JuneToken); reviewer=(New-JuneToken); reader=(New-JuneToken); webhook=(New-JuneToken); n8n=(New-JuneToken) }
  $secrets | ConvertTo-Json | Set-Content -LiteralPath $secretsFile
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $secretsFile /inheritance:r /grant:r "${identity}:(F)" 'SYSTEM:(F)' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict credential file access.' }
$secrets = Get-Content -LiteralPath $secretsFile -Raw | ConvertFrom-Json
$env:JUNE_WORKER_TOKEN = $secrets.worker
$env:JUNE_REVIEW_TOKEN = $secrets.reviewer
$env:JUNE_READER_TOKEN = $secrets.reader
$env:JUNE_MEMORY_VAULT = 'D:\June\MemoryVault\june'
$env:JUNE_BACKUP_ROOT = 'D:\June\Backups'
$env:JUNE_OPENCLAW_ROOT = Join-Path $env:USERPROFILE '.openclaw'
$env:N8N_USER_FOLDER = Join-Path $project 'automation\n8n\runtime\user'
$env:N8N_ENCRYPTION_KEY = $secrets.n8n
$env:N8N_LISTEN_ADDRESS = '127.0.0.1'
$env:N8N_HOST = '127.0.0.1'
$env:N8N_PORT = '5678'
$env:N8N_PROTOCOL = 'http'
$env:WEBHOOK_URL = 'http://127.0.0.1:5678/'
$env:N8N_RUNNERS_BROKER_LISTEN_ADDRESS = '127.0.0.1'
$env:GENERIC_TIMEZONE = 'Asia/Calcutta'
$env:N8N_DIAGNOSTICS_ENABLED = 'false'
$env:N8N_VERSION_NOTIFICATIONS_ENABLED = 'false'
$env:N8N_TEMPLATES_ENABLED = 'false'
$env:N8N_PERSONALIZATION_ENABLED = 'false'
$env:N8N_BLOCK_ENV_ACCESS_IN_NODE = 'true'
