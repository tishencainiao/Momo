' Momo 数据备份无窗口启动器
Set ws = CreateObject("WScript.Shell")
ws.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""E:\Learn\Momo\scripts\backup.ps1""", 0, False
