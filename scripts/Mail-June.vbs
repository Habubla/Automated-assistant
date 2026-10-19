Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
script = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "open-inbox.ps1")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """ -View Mail"
exitCode = shell.Run(command, 0, True)
If exitCode <> 0 Then MsgBox "June could not open Mail. Check .local\runtime\last-start-error.txt in your June project for details.", 48, "June"
WScript.Quit exitCode
