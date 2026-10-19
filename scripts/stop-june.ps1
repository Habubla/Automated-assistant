$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
$runtime=Join-Path $project '.local\runtime'
$mutex=New-Object Threading.Mutex($false,'Local\JuneLifecycle')
$locked=$false
. (Join-Path $PSScriptRoot 'owned-services.ps1')
try{
 $locked=$mutex.WaitOne(120000);if(-not $locked){throw 'Another June operation is in progress.'}
 $recordFile=Join-Path $runtime 'services.json'
 $records=@()
 if(Test-Path -LiteralPath $recordFile){$records=@(Read-JuneServiceRecords -Path $recordFile)}
 $records=@(Get-JuneServiceRecords -Project $project -Records $records)
 ConvertTo-Json -InputObject @($records) -Depth 4 | Set-Content -LiteralPath $recordFile
 $accessPath=Join-Path $project '.local\hub\access.json'
 if(Test-Path -LiteralPath $accessPath){
  $access=Get-Content -LiteralPath $accessPath -Raw|ConvertFrom-Json
  $session=New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $session.Cookies.Add((New-Object System.Net.Cookie('june_session',$access.token,'/','127.0.0.1')))
  $headers=@{'X-June-Action'='1';Origin='http://127.0.0.1:3211'}
  try{Invoke-RestMethod -Uri 'http://127.0.0.1:3211/api/prepare-stop' -Method Post -ContentType 'application/json' -Body '{}' -WebSession $session -Headers $headers -TimeoutSec 5|Out-Null}catch{}
 }
 & (Join-Path $env:APPDATA 'npm\openclaw.cmd') gateway stop --force --json | Out-Null
 $recordFile=Join-Path $runtime 'services.json'
 if(Test-Path -LiteralPath $recordFile){
  $records=@(Read-JuneServiceRecords -Path $recordFile)
  foreach($name in @('Widget','N8n','Hub','Memory','Ollama')){
   foreach($record in @($records|Where-Object {$_.Service -eq $name})){
    $p=Get-Process -Id $record.Pid -ErrorAction SilentlyContinue
    if(-not $p){continue}
    if($p.StartTime.ToUniversalTime().Ticks -ne ([datetime]$record.StartTime).ToUniversalTime().Ticks){throw 'Process identity changed; refusing to stop it.'}
    $cim=Get-CimInstance Win32_Process -Filter ("ProcessId="+$record.Pid)
    if($cim.CommandLine -notlike ('*'+$record.Expected+'*')){throw 'Process ownership is not verified.'}
    if($name -eq 'Hub'){try{Invoke-RestMethod -Uri 'http://127.0.0.1:3211/api/shutdown' -Method Post -ContentType 'application/json' -Body '{}' -WebSession $session -Headers $headers -TimeoutSec 3|Out-Null;Start-Sleep -Seconds 2}catch{}}
    if(Get-Process -Id $record.Pid -ErrorAction SilentlyContinue){& taskkill.exe /PID $record.Pid /T /F | Out-Null}
   }
  }
  '[]'|Set-Content -LiteralPath $recordFile
 }
 try{Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/generate' -Method Post -ContentType 'application/json' -Body '{"model":"qwen3.5:4b","keep_alive":0}' -TimeoutSec 15|Out-Null}catch{}
 Write-Output 'June services and workflows are stopped. Pending work is retained.'
}finally{if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()}
