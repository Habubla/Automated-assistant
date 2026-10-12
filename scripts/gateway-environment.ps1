$ErrorActionPreference='Stop'
$settings='D:\June\Settings'
$credentialFile='D:\June\JuneMemory\.local\service-secrets.json'
$private=Get-Content -LiteralPath $credentialFile -Raw | ConvertFrom-Json
$env:JUNE_READER_TOKEN=$private.reader
$env:JUNE_WORKER_TOKEN=$private.worker
$env:JUNE_SETTINGS_ROOT=$settings
$env:JUNE_PENDING_ROOT='D:\June\JuneMemory\.local\gemini-pending'
$poolFile=Join-Path $settings 'gemini-api-keys.txt'
if(Test-Path -LiteralPath $poolFile){
 $keys=@(Get-Content -LiteralPath $poolFile | ForEach-Object {$_.Trim()} | Where-Object {$_ -and -not $_.StartsWith('#')})
 $valid=@($keys | Where-Object {$_ -match '^[A-Za-z0-9_.-]{20,256}$'} | Select-Object -Unique)
 if($valid.Count -ne $keys.Count){Write-Warning 'Some key-pool lines were duplicate or invalid and were skipped.'}
 if($valid.Count){$env:GEMINI_API_KEYS=$valid -join ','}
}
$env:OPENCLAW_GATEWAY_PORT='18789'
$env:OPENCLAW_WINDOWS_TASK_NAME='OpenClaw Gateway'
$env:OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER='1'
$env:OPENCLAW_SERVICE_MARKER='openclaw'
$env:OPENCLAW_SERVICE_KIND='gateway'
$env:NODE_OPTIONS=''
& 'C:\Program Files\nodejs\node.exe' --max-old-space-size=8192 (Join-Path $env:APPDATA 'npm\node_modules\openclaw\dist\index.js') gateway --port 18789 --task-supervisor
exit $LASTEXITCODE
