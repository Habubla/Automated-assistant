import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync,spawnSync} from "node:child_process";
const windows=process.platform==="win32";
const project=path.resolve(import.meta.dirname,"..");
const shell=path.join(process.env.SystemRoot??"C:/Windows","System32/WindowsPowerShell/v1.0/powershell.exe");
const quote=value=>"'"+value.replaceAll("'","''")+"'";
function temporary(){return fs.mkdtempSync(path.join(os.tmpdir(),"june-launcher-test-"));}
function cleanup(dir){const root=path.resolve(os.tmpdir())+path.sep;if(!path.resolve(dir).startsWith(root)||!path.basename(dir).startsWith("june-launcher-test-"))throw Error("Unsafe cleanup");fs.rmSync(dir,{recursive:true,force:true});}
test("Windows PowerShell 5.1 reads empty, single and multiple service records without nested dates",{skip:!windows},()=>{
 const dir=temporary();
 try{
  const script=path.join(dir,"check.ps1");
  fs.writeFileSync(script,`$ErrorActionPreference='Stop'
. ${quote(path.join(project,"scripts/owned-services.ps1"))}
$recordsFile=Join-Path $PSScriptRoot 'services.json'
if(@(Read-JuneServiceRecords -Path $recordsFile).Count -ne 0){throw 'Absent records failed'}
'[]' | Set-Content -LiteralPath $recordsFile
if(@(Read-JuneServiceRecords -Path $recordsFile).Count -ne 0){throw 'Empty records failed'}
$proc=Get-Process -Id $PID
$row=@{Service='Hub';Pid=$PID;StartTime=$proc.StartTime.ToUniversalTime().ToString('o');Expected=$PSCommandPath}
ConvertTo-Json -InputObject $row | Set-Content -LiteralPath $recordsFile
if(@(Read-JuneServiceRecords -Path $recordsFile).Count -ne 1){throw 'Single record failed'}
ConvertTo-Json -InputObject @($row,$row) | Set-Content -LiteralPath $recordsFile
$rows=@(Read-JuneServiceRecords -Path $recordsFile)
if($rows.Count -ne 2 -or $rows[0].StartTime -is [Array]){throw 'Nested records returned'}
$owned=@(Get-JuneServiceRecords -Project $PSScriptRoot -Records $rows)
if($owned.Count -ne 1){throw 'Ownership validation failed'}
'PASS'
`);
  const output=execFileSync(shell,["-NoProfile","-ExecutionPolicy","Bypass","-File",script],{encoding:"utf8",windowsHide:true,timeout:30000});
  assert.match(output,/PASS/);
 }finally{cleanup(dir);}
});
test("Windows sign-in launcher returns its child failure instead of reporting false success",{skip:!windows},()=>{
 const dir=temporary();
 try{
  fs.copyFileSync(path.join(project,"scripts/Startup-June.vbs"),path.join(dir,"Startup-June.vbs"));
  fs.writeFileSync(path.join(dir,"start-june.ps1"),"exit 23\n");
  const result=spawnSync(path.join(process.env.SystemRoot,"System32/cscript.exe"),["//nologo",path.join(dir,"Startup-June.vbs")],{encoding:"utf8",windowsHide:true,timeout:30000});
  assert.equal(result.status,23,result.stderr);
 }finally{cleanup(dir);}
});
