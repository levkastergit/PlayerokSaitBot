# Запуск перехвата трафика покупки Robux через Microsoft Store.
#
# Перед запуском:
#   1) установлен mitmproxy (pip install mitmproxy);
#   2) выполнен trust-cert.ps1 (от админа) — сертификат mitmproxy доверен;
#   3) установлено приложение Roblox из Microsoft Store.
#
# Скрипт: ставит loopback-исключение для UWP Roblox, включает системный прокси на
# mitmproxy, запускает mitmdump с аддоном highlight.py и пишет флоу в robux-capture.flows.
# По Ctrl+C прокси выключается обратно.

$ErrorActionPreference = 'Stop'
$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$flows = Join-Path $here 'robux-capture.flows'
$addon = Join-Path $here 'highlight.py'

$mit = (Get-Command mitmdump -ErrorAction SilentlyContinue).Source
if (-not $mit) { $mit = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\Scripts\mitmdump.exe' }
if (-not (Test-Path $mit)) { throw "mitmdump не найден. Установите: pip install mitmproxy" }

# Loopback-исключение для UWP-приложения Roblox (иначе оно не достучится до 127.0.0.1).
$pkg = (Get-AppxPackage *Roblox* | Select-Object -First 1).PackageFamilyName
if ($pkg) {
  CheckNetIsolation LoopbackExempt -a -n="$pkg" | Out-Null
  Write-Host "Loopback exempt включён для: $pkg"
} else {
  Write-Warning "Приложение Roblox (UWP) не найдено. Установите его из Microsoft Store и перезапустите скрипт."
}

# Системный прокси → mitmproxy (127.0.0.1:8080).
$reg = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$prevServer = (Get-ItemProperty $reg -Name ProxyServer -ErrorAction SilentlyContinue).ProxyServer
$prevEnable = (Get-ItemProperty $reg -Name ProxyEnable -ErrorAction SilentlyContinue).ProxyEnable
Set-ItemProperty $reg -Name ProxyServer -Value '127.0.0.1:8080'
Set-ItemProperty $reg -Name ProxyEnable -Value 1
Write-Host "Системный прокси включён: 127.0.0.1:8080"

try {
  Write-Host ""
  Write-Host "=== ИДЁТ ПЕРЕХВАТ ===  Теперь в приложении Roblox купите минимальный пак Robux, оплатив 'Microsoft account balance'."
  Write-Host "Флоу: $flows   |   читаемая выжимка: $(Join-Path $here 'robux-capture.txt')"
  Write-Host "Остановить: Ctrl+C"
  Write-Host ""
  & $mit -s $addon -w $flows
}
finally {
  if ($null -ne $prevServer) { Set-ItemProperty $reg -Name ProxyServer -Value $prevServer }
  Set-ItemProperty $reg -Name ProxyEnable -Value ([int]([bool]$prevEnable))
  Write-Host "Системный прокси возвращён в прежнее состояние."
}
