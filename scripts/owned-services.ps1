# Windows PowerShell 5.1 returns JSON arrays as one pipeline object.
# Enumerate the decoded value directly so callers always receive flat records.
function Read-JuneServiceRecords([string]$Path) {
 if(-not(Test-Path -LiteralPath $Path)){return}
 $decoded=Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
 foreach($record in $decoded){
  if($null -eq $record){continue}
  if($record -is [Array]){throw 'June service tracking contains a nested array.'}
  if($record.StartTime -is [Array] -or $record.Pid -is [Array]){throw 'June service tracking contains invalid identity fields.'}
  $record
 }
}
# Recover only June-owned service wrappers whose exact launch command is known.
function Get-JuneServiceRecords([string]$Project, [object[]]$Records=@()) {
 $wrapper=Join-Path $Project 'scripts\run-service.ps1'
 $pattern='(?i)(?:^|\s)-File\s+"?'+[regex]::Escape($wrapper)+'"?\s+-Service\s+(Memory|Hub|N8n)\s*$'
 $widgetPath=Join-Path $Project 'scripts\task-widget.ps1'
 $widgetPattern='(?i)(?:^|\s)-File\s+"?'+[regex]::Escape($widgetPath)+'"?\s*$'
 $verified=@{}
 foreach($record in $Records){
  $proc=Get-Process -Id $record.Pid -ErrorAction SilentlyContinue
  if(-not $proc){continue}
  if($proc.StartTime.ToUniversalTime().Ticks -ne ([datetime]$record.StartTime).ToUniversalTime().Ticks){continue}
  $details=Get-CimInstance Win32_Process -Filter ("ProcessId="+$record.Pid)
  if($details.CommandLine -like ('*'+$record.Expected+'*')){$verified[[string]$record.Pid]=$record}
 }
 foreach($details in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'")){
  $expected=$wrapper
  if($details.CommandLine -match $pattern){$service=$Matches[1]}
  elseif($details.CommandLine -match $widgetPattern){$service='Widget';$expected=$widgetPath}
  else{continue}
  $proc=Get-Process -Id $details.ProcessId -ErrorAction SilentlyContinue
  if(-not $proc){continue}
  if([math]::Abs(($proc.StartTime.ToUniversalTime()-$details.CreationDate.ToUniversalTime()).TotalSeconds) -gt 1){continue}
  $verified[[string]$proc.Id]=@{Service=$service;Pid=$proc.Id;StartTime=$proc.StartTime.ToUniversalTime().ToString('o');Expected=$expected}
 }
 @($verified.Values)
}
