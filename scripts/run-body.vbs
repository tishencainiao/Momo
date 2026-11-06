' Momo 身体启动器（无控制台窗口）
' 用法：双击本文件，或在「启动」文件夹放一个快捷方式实现开机自启
Option Explicit

Dim fso, sh, root, pyw
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

' scripts\run-body.vbs -> 上一级是 Momo 根目录
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

pyw = "pythonw.exe"
sh.CurrentDirectory = root
sh.Run """" & pyw & """ """ & root & "\body\main.py""", 0, False
