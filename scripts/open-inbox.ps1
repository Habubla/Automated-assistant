param([ValidateSet('Messages','Mail')][string]$View='Messages')
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'start-june.ps1') -NoDashboard | Out-Null
$access=Get-Content -LiteralPath (Join-Path $project '.local\hub\access.json') -Raw|ConvertFrom-Json
$page=if($View -eq 'Mail'){'mail'}else{'messages'}
$url='http://127.0.0.1:3211/'+$page+'#token='+$access.token
$edge='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if(Test-Path -LiteralPath $edge){
 $profile=Join-Path $project '.local\desktop-browser'
 Start-Process -FilePath $edge -ArgumentList ('--new-window --no-first-run --no-default-browser-check --user-data-dir="'+$profile+'" --app="'+$url+'"') -WindowStyle Normal
}else{Start-Process $url}
