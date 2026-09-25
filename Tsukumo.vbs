' Avvia Tsukumo senza terminale: doppio click (o il collegamento sul
' desktop). Electron mostra subito il personaggio con un biglietto d'attesa,
' avvia da solo il backend Python e scrive tutto in logs\companion.log:
' se qualcosa non parte, il motivo e' li' (o nel biglietto stesso).

Option Explicit

Dim fso, shell, root, electronDir, electronExe, logDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
electronDir = root & "\electron"
electronExe = electronDir & "\node_modules\electron\dist\electron.exe"
logDir = root & "\logs"

If Not fso.FileExists(electronExe) Then
    MsgBox "Electron non e' installato." & vbCrLf & vbCrLf & _
        "Esegui una volta:  .\start.ps1 -Setup", vbExclamation, "Tsukumo"
    WScript.Quit 1
End If
If Not fso.FileExists(root & "\frontend\dist\index.html") Then
    MsgBox "L'interfaccia non e' compilata." & vbCrLf & vbCrLf & _
        "Esegui una volta:  .\start.ps1 -Setup", vbExclamation, "Tsukumo"
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
