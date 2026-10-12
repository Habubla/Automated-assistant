Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
script = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "start-june.ps1")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """"
shell.Run command, 0, False
