param([ValidateSet('Memory','Hub','N8n')][string]$Service)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'local-settings.ps1')
$env:JUNE_SETTINGS_ROOT='D:\June\Settings'
$node='C:\Program Files\nodejs\node.exe'
if($Service -eq 'Memory'){& $node (Join-Path $project 'src\server.js')}
elseif($Service -eq 'Hub'){& $node (Join-Path $project 'src\hub\server.js')}
else{
 Remove-Item Env:JUNE_REVIEW_TOKEN,Env:JUNE_READER_TOKEN,Env:JUNE_WORKER_TOKEN -ErrorAction SilentlyContinue
 & $node (Join-Path $project 'automation\n8n\runtime\node_modules\n8n\bin\n8n') start
}
exit $LASTEXITCODE
