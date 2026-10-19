$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
$runtime=Join-Path $project '.local\runtime'
New-Item -ItemType Directory -Force -Path $runtime|Out-Null
$arg='-NoProfile -ExecutionPolicy Bypass -STA -File "'+(Join-Path $PSScriptRoot 'task-widget.ps1')+'"'
$p=Start-Process -FilePath 'powershell.exe' -ArgumentList $arg -WindowStyle Hidden -PassThru -WorkingDirectory $project -RedirectStandardOutput (Join-Path $runtime 'Widget-out.log') -RedirectStandardError (Join-Path $runtime 'Widget-error.log')
$p
