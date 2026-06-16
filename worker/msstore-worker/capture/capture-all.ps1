# Полный одно-кнопочный перехват покупки Robux через Microsoft Store.
#
# ⚠️ ЗАПУСКАТЬ ОТ ИМЕНИ АДМИНИСТРАТОРА (нужно для доверия сертификату и loopback-исключения UWP).
# Делает всё сам: доверяет сертификат mitmproxy, открывает loopback для приложения Roblox,
# включает системный прокси, пишет трафик. По Ctrl+C — возвращает прокси обратно.
#
#   powershell -ExecutionPolicy Bypass -File .\capture-all.ps1
#
$ErrorActionPreference = 'Stop'

# Проверка прав администратора.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Запустите этот скрипт от имени АДМИНИСТРАТОРА (нужно для сертификата и loopback)." }

$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$flows = Join-Path $here 'robux-capture.flows'
$addon = Join-Path $here 'highlight.py'
$txt   = Join-Path $here 'robux-capture.txt'
$cer   = Join-Path $env:USERPROFILE '.mitmproxy\mitmproxy-ca-cert.cer'

$mit = (Get-Command mitmdump -ErrorAction SilentlyContinue).Source
if (-not $mit) { $mit = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\Scripts\mitmdump.exe' }
if (-not (Test-Path $mit)) { throw "mitmdump не найден. pip install mitmproxy" }
if (-not (Test-Path $cer)) { throw "Нет сертификата $cer — запустите mitmdump один раз." }

# Чистим прошлую выжимку, чтобы не путаться.
Remove-Item $txt -ErrorAction SilentlyContinue

# 1) Доверяем сертификат mitmproxy.
Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Write-Host "[1/3] Сертификат mitmproxy доверен."

# 2) Loopback-исключение для UWP Roblox.
$pkg = (Get-AppxPackage *Roblox* | Select-Object -First 1).PackageFamilyName
if ($pkg) { CheckNetIsolation LoopbackExempt -a -n="$pkg" | Out-Null; Write-Host "[2/3] Loopback открыт для: $pkg" }
else { Write-Warning "Приложение Roblox не найдено." }

# 3) Системный прокси на mitmproxy.
$reg = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$prevServer = (Get-ItemProperty $reg -Name ProxyServer -ErrorAction SilentlyContinue).ProxyServer
$prevEnable = (Get-ItemProperty $reg -Name ProxyEnable -ErrorAction SilentlyContinue).ProxyEnable
Set-ItemProperty $reg -Name ProxyServer -Value '127.0.0.1:8080'
Set-ItemProperty $reg -Name ProxyEnable -Value 1
Write-Host "[3/3] Прокси включён: 127.0.0.1:8080"

Write-Host ""
Write-Host "==================================================================="
Write-Host " ЗАПИСЬ ИДЁТ. Теперь в приложении Roblox купите МИНИМАЛЬНЫЙ пак Robux,"
Write-Host " выбрав оплату 'Microsoft account balance', и подтвердите."
Write-Host " Затем нажмите Ctrl+C здесь."
Write-Host "==================================================================="
Write-Host ""

try {
  & $mit -s $addon -w $flows
}
finally {
  if ($null -ne $prevServer) { Set-ItemProperty $reg -Name ProxyServer -Value $prevServer }
  Set-ItemProperty $reg -Name ProxyEnable -Value ([int]([bool]$prevEnable))
  Write-Host ""
  Write-Host "Прокси возвращён в прежнее состояние."
  Write-Host "Файлы: $txt  и  $flows"
  Write-Host "Гигиена: снять доверие сертификату — .\trust-cert.ps1 -Remove (от админа)."
}
