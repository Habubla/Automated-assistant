# Recover only June-owned service wrappers whose exact launch command is known.
function Get-JuneServiceRecords([string]$Project, [object[]]$Records=@()) {
 $wrapper=Join-Path $Project 'scripts\run-service.ps1'
 $pattern='(?i)(?:^|\s)-File\s+"?'+[regex]::Escape($wrapper)+'"?\s+-Service\s+(Memory|Hub|N8n)\s*$'
 $verified=@{}
 foreach($record in $Records){
  $proc=Get-Process -Id $record.Pid -ErrorAction SilentlyContinue
  if(-not $proc){continue}
  if($proc.StartTime.ToUniversalTime().Ticks -ne ([datetime]$record.StartTime).ToUniversalTime().Ticks){continue}
  $details=Get-CimInstance Win32_Process -Filter ("ProcessId="+$record.Pid)
  if($details.CommandLine -like ('*'+$record.Expected+'*')){$verified[[string]$record.Pid]=$record}
 }
 foreach($details in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'")){
  if($details.CommandLine -notmatch $pattern){continue}
  $service=$Matches[1]
  $proc=Get-Process -Id $details.ProcessId -ErrorAction SilentlyContinue
  if(-not $proc){continue}
  if([math]::Abs(($proc.StartTime.ToUniversalTime()-$details.CreationDate.ToUniversalTime()).TotalSeconds) -gt 1){continue}
  $verified[[string]$proc.Id]=@{Service=$service;Pid=$proc.Id;StartTime=$proc.StartTime.ToUniversalTime().ToString('o');Expected=$wrapper}
 }
 @($verified.Values)
}
