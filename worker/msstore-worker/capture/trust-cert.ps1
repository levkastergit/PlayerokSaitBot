# Доверяет корневому сертификату mitmproxy в системе — нужно, чтобы расшифровать HTTPS.
#
# ⚠️ ВНИМАНИЕ: это системное доверие к ПЕРЕХВАТЫВАЮЩЕМУ центру сертификации.
#    Делайте это ТОЛЬКО на тестовой машине / VM, не на основном ПК.
#    Запускать ОТ ИМЕНИ АДМИНИСТРАТОРА.
#    Снять доверие после съёмки:  powershell -ExecutionPolicy Bypass -File trust-cert.ps1 -Remove
#
param([switch]$Remove)
$ErrorActionPreference = 'Stop'

$cer = Join-Path $env:USERPROFILE '.mitmproxy\mitmproxy-ca-cert.cer'

if ($Remove) {
  Get-ChildItem Cert:\LocalMachine\Root |
    Where-Object { $_.Subject -like '*mitmproxy*' } |
    ForEach-Object { Remove-Item $_.PSPath -Force; Write-Host "Удалён: $($_.Thumbprint)" }
  Write-Host "Доверие к mitmproxy снято."
  return
}

if (-not (Test-Path $cer)) {
  throw "Не найден $cer. Сначала один раз запустите mitmdump (или start-capture.ps1), чтобы он создал сертификат."
}

Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Write-Host "Сертификат mitmproxy добавлен в доверенные корневые (LocalMachine\Root)."
Write-Host "После съёмки уберите его:  trust-cert.ps1 -Remove"
