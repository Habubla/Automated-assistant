param([switch]$NoDashboard)
$ErrorActionPreference='Stop'
$project=Split-Path -Parent $PSScriptRoot
$runtime=Join-Path $project '.local\runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$mutex=New-Object Threading.Mutex($false,'Local\JuneLifecycle')
$locked=$false
$dashboardOpened=$false
. (Join-Path $PSScriptRoot 'owned-services.ps1')
function Ready([string]$url,[string]$service=''){
 try{$r=Invoke-RestMethod -Uri $url -TimeoutSec 2;return (($r.ok -eq $true -or $r.status -eq 'ok' -or $r.ready -eq $true -or $null -ne $r.models) -and (-not $service -or $r.service -eq $service))}catch{return $false}
}
try{
 $locked=$mutex.WaitOne(120000);if(-not $locked){throw 'Another June start or stop is still running.'}
 $recordFile=Join-Path $runtime 'services.json';$records=@()
 $records=@(Read-JuneServiceRecords -Path $recordFile)
 $records=@(Get-JuneServiceRecords -Project $project -Records $records)
 if(-not (Ready 'http://127.0.0.1:11434/api/tags')){
  $ollama=Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
  if(-not(Test-Path -LiteralPath $ollama)){throw 'Ollama is not installed at its configured location.'}
  $p=Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'ollama-out.log') -RedirectStandardError (Join-Path $runtime 'ollama-error.log')
  $records+=@{Service='Ollama';Pid=$p.Id;StartTime=$p.StartTime.ToUniversalTime().ToString('o');Expected=$ollama}
 }
 foreach($spec in @(@{Name='Memory';Port=3210;Health='/healthz';Identity='june-memory'},@{Name='Hub';Port=3211;Health='/healthz';Identity='june-hub'},@{Name='N8n';Port=5680;Health='/healthz';Identity=''})){
  if(Ready ("http://127.0.0.1:"+$spec.Port+$spec.Health) $spec.Identity){
   if($spec.Name -eq 'N8n' -and -not @($records|Where-Object {$_.Service -eq 'N8n'}).Count){throw 'June automation port 5680 is occupied by an unmanaged service. June did not stop or replace it.'}
   continue
  }
  $prior=@($records|Where-Object {
   if($_.Service -ne $spec.Name){return $false}
   $existing=Get-Process -Id $_.Pid -ErrorAction SilentlyContinue
   if(-not $existing -or $existing.StartTime.ToUniversalTime().Ticks -ne ([datetime]$_.StartTime).ToUniversalTime().Ticks){return $false}
   $details=Get-CimInstance Win32_Process -Filter ("ProcessId="+$_.Pid)
   return $details.CommandLine -like ('*'+$_.Expected+'*')
  })
  if($prior.Count){continue}
  $arg='-NoProfile -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'run-service.ps1')+'" -Service '+$spec.Name
  $p=Start-Process -FilePath 'powershell.exe' -ArgumentList $arg -WorkingDirectory $project -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime ($spec.Name+'-out.log')) -RedirectStandardError (Join-Path $runtime ($spec.Name+'-error.log'))
  $records=@($records|Where-Object {$_.Service -ne $spec.Name})
  $records+=@{Service=$spec.Name;Pid=$p.Id;StartTime=$p.StartTime.ToUniversalTime().ToString('o');Expected='run-service.ps1'}
 }
 ConvertTo-Json -InputObject @($records) -Depth 4 | Set-Content -LiteralPath $recordFile
 if(-not(Ready 'http://127.0.0.1:18789/readyz')){Start-ScheduledTask -TaskName 'OpenClaw Gateway'}
 $deadline=(Get-Date).AddSeconds(840)
 do{
  if(-not @($records|Where-Object {$_.Service -eq 'Widget'}).Count -and (Ready 'http://127.0.0.1:3211/healthz' 'june-hub')){
   $p=& (Join-Path $PSScriptRoot 'start-widget.ps1')
   $records+=@{Service='Widget';Pid=$p.Id;StartTime=$p.StartTime.ToUniversalTime().ToString('o');Expected=(Join-Path $PSScriptRoot 'task-widget.ps1')}
   ConvertTo-Json -InputObject @($records) -Depth 4|Set-Content -LiteralPath $recordFile
  }
  if(-not $NoDashboard -and -not $dashboardOpened -and (Ready 'http://127.0.0.1:3211/healthz' 'june-hub')){
   $access=Get-Content -LiteralPath (Join-Path $project '.local\hub\access.json') -Raw|ConvertFrom-Json
   Start-Process ('http://127.0.0.1:3211/#token='+$access.token)
   $dashboardOpened=$true
  }
  $ready=(Ready 'http://127.0.0.1:3210/healthz' 'june-memory') -and (Ready 'http://127.0.0.1:3211/healthz' 'june-hub') -and (Ready 'http://127.0.0.1:5680/healthz/readiness') -and (Ready 'http://127.0.0.1:18789/readyz')
  if($ready){break};Start-Sleep -Seconds 2
 }while((Get-Date)-lt $deadline)
 if(-not $ready){throw 'A June service is not ready. Inspect D:\June\JuneMemory\.local\runtime logs.'}
 if(-not $NoDashboard -and -not $dashboardOpened){
  $access=Get-Content -LiteralPath (Join-Path $project '.local\hub\access.json') -Raw|ConvertFrom-Json
  Start-Process ('http://127.0.0.1:3211/#token='+$access.token)
 }
 [pscustomobject]@{ok=$true;Gateway='Ready';Memory='Ready';Hub='Ready';Workflows='Ready';StartedAt=(Get-Date).ToUniversalTime().ToString('o')}|ConvertTo-Json | Tee-Object -FilePath (Join-Path $runtime 'last-start-success.json')
 $errorFile=Join-Path $runtime 'last-start-error.txt'
 if(Test-Path -LiteralPath $errorFile){Remove-Item -LiteralPath $errorFile}
}catch{
 $_.Exception.Message|Set-Content -LiteralPath (Join-Path $runtime 'last-start-error.txt')
 throw
}finally{if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()}
