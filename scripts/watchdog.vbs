' Momo 看门狗无窗口启动器（wscript 是 GUI 子系统，不会闪控制台）
Set ws = CreateObject("WScript.Shell")
ws.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""E:\Learn\Momo\scripts\watchdog.ps1""", 0, False
