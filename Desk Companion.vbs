' Avvia il Desk Companion senza terminale: doppio click (o il collegamento
' sul desktop). Electron avvia da solo il backend Python; tutto l'output va
' in logs\companion.log, utile se qualcosa non parte.

Option Explicit

Dim fso, shell, root, electronDir, electronExe, logDir, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
electronDir = root & "\electron"
electronExe = electronDir & "\node_modules\electron\dist\electron.exe"
logDir = root & "\logs"

If Not fso.FileExists(electronExe) Then
    MsgBox "Electron non e' installato." & vbCrLf & vbCrLf & _
        "Esegui una volta:  .\start.ps1 -Setup", vbExclamation, "Desk Companion"
    WScript.Quit 1
End If
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir

' Se questa variabile e' impostata Electron parte come Node e non apre finestre.
On Error Resume Next
shell.Environment("Process").Remove "ELECTRON_RUN_AS_NODE"
On Error GoTo 0

' Il processo figlio eredita l'ambiente di questo script: cosi' sa dove scrivere.
shell.Environment("Process")("DC_LOG_FILE") = logDir & "\companion.log"

shell.CurrentDirectory = electronDir
shell.Run """" & electronExe & """ .", 0, False
