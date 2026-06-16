# Перехват ВТОРОЙ попытки: Microsoft/Xbox/Live проходят МИМО mitmproxy (нативное окно
# оплаты не ломается → покупка проходит), а *.roblox.com по-прежнему пишется — чтобы
# увидеть, зачисляет ли Roblox Robux веб-запросом после оплаты.
#
# ⚠️ ЭТО РЕАЛЬНАЯ ПОКУПКА — спишется баланс Microsoft-аккаунта. Берите МИНИМАЛЬНЫЙ пак.
# ⚠️ ЗАПУСКАТЬ ОТ ИМЕНИ АДМИНИСТРАТОРА.
#
#   powershell -ExecutionPolicy Bypass -File .\capture-purchase.ps1
#
$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Запустите от имени АДМИНИСТРАТОРА." }

$here  = Split-Path -Parent $MyInvocation.MyCommand.Path
$flows = Join-Path $here 'robux-purchase.flows'
$txt   = Join-Path $here 'robux-purchase.txt'
$addon = Join-Path $here 'highlight.py'
$cer   = Join-Path $env:USERPROFILE '.mitmproxy\mitmproxy-ca-cert.cer'

$mit = (Get-Command mitmdump -ErrorAction SilentlyContinue).Source
if (-not $mit) { $mit = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\Scripts\mitmdump.exe' }
if (-not (Test-Path $mit)) { throw "mitmdump не найден. pip install mitmproxy" }
if (-not (Test-Path $cer)) { throw "Нет сертификата $cer." }

Remove-Item $txt, $flows -ErrorAction SilentlyContinue

# Сертификат: доверяем, только если ещё не доверен.
$already = Get-ChildItem Cert:\LocalMachine\Root -ErrorAction SilentlyContinue | Where-Object { $_.Subject -like '*mitmproxy*' }
if (-not $already) { Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null; Write-Host "Сертификат доверен." }
else { Write-Host "Сертификат уже доверен." }

# Loopback для UWP Roblox.
$pkg = (Get-AppxPackage *Roblox* | Select-Object -First 1).PackageFamilyName
if ($pkg) { CheckNetIsolation LoopbackExempt -a -n="$pkg" | Out-Null; Write-Host "Loopback открыт: $pkg" }

# Системный прокси.
$reg = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$prevServer = (Get-ItemProperty $reg -Name ProxyServer -ErrorAction SilentlyContinue).ProxyServer
$prevEnable = (Get-ItemProperty $reg -Name ProxyEnable -ErrorAction SilentlyContinue).ProxyEnable
Set-ItemProperty $reg -Name ProxyServer -Value '127.0.0.1:8080'
Set-ItemProperty $reg -Name ProxyEnable -Value 1

# Аддон пишет выжимку в отдельный файл этого прогона.
$env:CAPTURE_TXT = $txt

# Microsoft/Xbox/Live проходят мимо перехвата — чтобы нативная оплата работала.
$ignore = '(\.microsoft\.com|\.live\.com|\.xboxlive\.com|\.windows\.com)(:\d+)?$'

Write-Host ""
Write-Host "==================================================================="
Write-Host " ЗАПИСЬ ИДЁТ (Microsoft в обход, Roblox пишется)."
Write-Host " Купите МИНИМАЛЬНЫЙ пак Robux, оплата 'Microsoft account balance', подтвердите."
Write-Host " Дождитесь зачисления Robux на аккаунт, затем Ctrl+C."
Write-Host "==================================================================="
Write-Host ""

try {
  & $mit -s $addon -w $flows --ignore-hosts $ignore
}
finally {
  if ($null -ne $prevServer) { Set-ItemProperty $reg -Name ProxyServer -Value $prevServer }
  Set-ItemProperty $reg -Name ProxyEnable -Value ([int]([bool]$prevEnable))
  Write-Host ""
  Write-Host "Прокси возвращён. Файлы: $txt  и  $flows"
}
