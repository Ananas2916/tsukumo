' Starts Tsukumo without a terminal: double click (or the desktop
' shortcut). Electron shows the character right away with a waiting card,
' starts the Python backend by itself and writes everything to
' logs\companion.log: if something doesn't start, the reason is there (or on
' the card itself).

Option Explicit

Dim fso, shell, root, electronDir, electronExe, logDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
electronDir = root & "\electron"
electronExe = electronDir & "\node_modules\electron\dist\electron.exe"
logDir = root & "\logs"

If Not fso.FileExists(electronExe) Then
    MsgBox "Electron is not installed." & vbCrLf & vbCrLf & _
        "Run once:  .\start.ps1 -Setup", vbExclamation, "Tsukumo"
    WScript.Quit 1
End If
If Not fso.FileExists(root & "\frontend\dist\index.html") Then
    MsgBox "The interface is not built." & vbCrLf & vbCrLf & _
        "Run once:  .\start.ps1 -Setup", vbExclamation, "Tsukumo"
    WScript.Quit 1
End If
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir

' With this variable set Electron starts as Node and opens no windows.
On Error Resume Next
shell.Environment("Process").Remove "ELECTRON_RUN_AS_NODE"
On Error GoTo 0

' The child process inherits this script's environment: that's how it knows where to write.
shell.Environment("Process")("DC_LOG_FILE") = logDir & "\companion.log"

shell.CurrentDirectory = electronDir
shell.Run """" & electronExe & """ .", 0, False
