# 安装 Momo 守护计划任务（方案 B，XML 方式，支持失败自动重试）
$ErrorActionPreference = 'Stop'
$momo = 'E:\Learn\Momo'
$taskName = 'MomoSupervisor'
$xmlPath = Join-Path $momo 'scripts\MomoSupervisor.xml'

$user = "{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME
$ps = 'powershell.exe'
$argLine = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}\supervise.ps1"' -f $momo

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Momo QQ 桥接守护进程（失败自动重试）</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$user</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$ps</Command>
      <Arguments>$argLine</Arguments>
    </Exec>
  </Actions>
</Task>
"@

$xml | Out-File -FilePath $xmlPath -Encoding Unicode
schtasks /Create /TN $taskName /XML $xmlPath /F 2>&1 | Out-String
Write-Output "---"
(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Select-Object TaskName,State | Format-Table -AutoSize | Out-String).Trim()
