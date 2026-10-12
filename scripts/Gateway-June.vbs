Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
script = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "gateway-environment.ps1")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """"
WScript.Quit shell.Run(command, 0, True)
