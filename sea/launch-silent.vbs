' Запускает ФУТБОЛ.TV без консольного окна (для Windows).
' Положите этот файл рядом с football-tv.exe и открывайте его двойным кликом.
' Сам сервер работает в фоне, сайт открывается в браузере по умолчанию.
' Остановить: Диспетчер задач → football-tv.exe → Завершить задачу.
Option Explicit
Dim fso, ws, dir
Set fso = CreateObject("Scripting.FileSystemObject")
Set ws = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
ws.CurrentDirectory = dir
ws.Run """" & dir & "\football-tv.exe""", 0, False
