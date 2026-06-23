# diag_buynow.ps1 -- why the "buy 80 Robux" dialog shows a blank white window.
# The purchase dialog is WebView2 (msedgewebview2.exe) loading www.microsoft.com/store/purchase
# + buynow.dynamics. Blank white = content failed to load. This checks the common
# causes that are NOT our code: TLS interception (mitmproxy/proxy), missing WebView2
# Runtime, system proxy, clock skew, host reachability. Read-only, buys nothing.
#
# Run via the PowerShell tool / a normal console. ASCII-only to avoid cp1251 issues.

$ErrorActionPreference = "Continue"
function Pass($m){ Write-Host ("  [OK]   " + $m) -ForegroundColor Green }
function Warn($m){ Write-Host ("  [WARN] " + $m) -ForegroundColor Yellow }
function Fail($m){ Write-Host ("  [FAIL] " + $m) -ForegroundColor Red }
function Info($m){ Write-Host ("  [..]   " + $m) -ForegroundColor Gray }
$verdict = @()

# Hosts the purchase dialog loads (from the captured buynow flow).
$phosts = @(
  "www.microsoft.com",
  "buynow.production.store-web.dynamics.com",
  "purchase.mp.microsoft.com",
  "collections.mp.microsoft.com",
  "paymentinstruments.mp.microsoft.com",
  "gold.xboxservices.com",
  "login.live.com"
)

Write-Host "`n===== 1. PROXY / TLS INTERCEPTION (top suspect) =====" -ForegroundColor Cyan

# 1a. WinINET system proxy (WebView2/Edge/Store honor it)
$ie = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"
try {
  $p = Get-ItemProperty -Path $ie -ErrorAction Stop
  if ($p.ProxyEnable -eq 1) {
    Fail("WinINET proxy ENABLED: " + $p.ProxyServer + "  (WebView2 routes through it)")
    $verdict += "System proxy is ON ($($p.ProxyServer)). If that is mitmproxy/capture, turn it off and retry the purchase."
  } else { Pass("WinINET proxy off (ProxyEnable=0)") }
} catch { Info("WinINET proxy: cannot read ($_)") }

# 1b. WinHTTP proxy
try {
  $wh = netsh winhttp show proxy 2>$null | Out-String
  if ($wh -match "Direct access") { Pass("WinHTTP: direct access (no proxy)") }
  else { Warn("WinHTTP proxy set:`n" + ($wh.Trim())); $verdict += "WinHTTP proxy configured -- consider: netsh winhttp reset proxy." }
} catch { Info("WinHTTP: cannot read") }

# 1c. Anyone listening on typical mitmproxy ports
foreach ($port in 8080,8081,8082) {
  try {
    $c = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    if ($c) {
      $procIds = ($c.OwningProcess | Sort-Object -Unique)
      foreach ($procId in $procIds) {
        $pr = Get-Process -Id $procId -ErrorAction SilentlyContinue
        $nm = if($pr){$pr.ProcessName}else{"?"}
        Fail("Port $port LISTENING: PID $procId $nm  (looks like a running proxy)")
      }
      $verdict += "A listener is up on port $port (likely mitmproxy/capture). Close it before purchasing."
    }
  } catch {}
}

# 1d. mitmproxy / python capture processes
$susp = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessName -match "mitm" -or $_.ProcessName -match "python" }
if ($susp) {
  foreach ($s in $susp) { Warn("Process running: " + $s.ProcessName + " (PID " + $s.Id + ")") }
  $verdict += "python/mitm processes are running -- if an active capture, it breaks WebView2 TLS."
} else { Pass("No mitmproxy/python processes seen") }

# 1e. mitmproxy CA in trusted roots (sign that interception was set up)
try {
  $mitm = Get-ChildItem Cert:\CurrentUser\Root, Cert:\LocalMachine\Root -ErrorAction SilentlyContinue |
          Where-Object { $_.Subject -match "mitmproxy" }
  if ($mitm) { Warn("mitmproxy CA present in trusted roots (interception was configured before).") }
  else { Pass("No mitmproxy CA in trusted roots") }
} catch {}

Write-Host "`n===== 2. TLS CERTS OF PURCHASE HOSTS (MITM detect) =====" -ForegroundColor Cyan
# Connect for real and inspect WHO signed the cert. Issuer = mitmproxy/unknown ->
# WebView2 distrusts it -> blank white window.
foreach ($h in $phosts) {
  try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $iar = $tcp.BeginConnect($h, 443, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(6000)) { $tcp.Close(); Fail("$h : TCP 443 timeout (network/firewall/DNS)"); $verdict += "$h unreachable on 443."; continue }
    $tcp.EndConnect($iar)
    $script:captured = $null
    $cb = [System.Net.Security.RemoteCertificateValidationCallback]{ param($snd,$cert,$chain,$err) $script:captured = $cert; return $true }
    $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, $cb)
    $ssl.AuthenticateAsClient($h)
    $c2 = $null
    if ($script:captured) { $c2 = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $script:captured }
    $issuer = if ($c2) { $c2.Issuer } else { "" }
    $subj   = if ($c2) { $c2.Subject } else { "" }
    if ($issuer -match "mitmproxy") { Fail("$h : cert issued by MITMPROXY -> WebView2 distrusts = blank window"); $verdict += "TLS to $h is intercepted by mitmproxy. THIS is the white-window cause." }
    elseif ($issuer -match "Microsoft|DigiCert|Akamai|Entrust|GlobalSign|Sectigo|Amazon|GeoTrust|Baltimore") { Pass("$h : signed normally (issuer=" + (($issuer -split ",")[0]) + ")") }
    elseif (-not $issuer) { Warn("$h : no issuer captured (TLS handshake odd / sandboxed egress)"); $verdict += "$h : could not read issuer -- run this on the actual purchase PC, not inside a sandbox." }
    else { Warn("$h : non-standard issuer -> subj=[" + $subj + "] issuer=[" + $issuer + "] (possible interception/corp filter)"); $verdict += "TLS to $h signed by suspicious CA: $issuer" }
    $ssl.Close(); $tcp.Close()
  } catch { Fail("$h : TLS check error -> $_"); $verdict += "$h : TLS fails to establish ($_)." }
}

Write-Host "`n===== 3. WEBVIEW2 RUNTIME (dialog is blank without it) =====" -ForegroundColor Cyan
$wvGuid = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
$paths = @(
  "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$wvGuid",
  "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$wvGuid",
  "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$wvGuid"
)
$wvVer = $null
foreach ($pp in $paths) {
  try { $v = (Get-ItemProperty -Path $pp -ErrorAction Stop).pv; if ($v) { $wvVer = $v; break } } catch {}
}
if ($wvVer) { Pass("WebView2 Runtime installed, version $wvVer") }
else {
  Fail("WebView2 Runtime NOT found in registry -> purchase dialog will be blank/white")
  $verdict += "WebView2 Runtime not installed. Get the Evergreen Runtime from developer.microsoft.com/microsoft-edge/webview2."
}
$wvExe = Get-ChildItem "C:\Program Files (x86)\Microsoft\EdgeWebView\Application\*\msedgewebview2.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($wvExe) { Pass("WebView2 binary present: " + $wvExe.FullName) } else { Warn("msedgewebview2.exe not in the standard path") }
$wvProc = Get-Process msedgewebview2 -ErrorAction SilentlyContinue
if ($wvProc) { Info("WebView2 processes currently running: " + $wvProc.Count) }

Write-Host "`n===== 4. CLOCK (skew breaks TLS) =====" -ForegroundColor Cyan
try {
  $req = [System.Net.WebRequest]::Create("https://www.microsoft.com")
  $req.Method = "HEAD"; $req.Timeout = 8000
  $r = $req.GetResponse()
  $serverDate = [datetime]::Parse($r.Headers["Date"]).ToUniversalTime()
  $r.Close()
  $skew = [math]::Abs(((Get-Date).ToUniversalTime() - $serverDate).TotalSeconds)
  if ($skew -lt 120) { Pass(("Clock OK (skew {0:N0}s)" -f $skew)) }
  else { Fail(("Clock off by {0:N0}s -> TLS certs may fail validation" -f $skew)); $verdict += "System clock off by ~$([int]$skew)s. Resync time (w32tm /resync)." }
} catch { Info("Clock: could not compare to server ($_)") }

Write-Host "`n===== 5. STORE / ACCOUNT (quick checks) =====" -ForegroundColor Cyan
$store = Get-Process WinStore.App,RobloxPlayerBeta,Windows10Universal -ErrorAction SilentlyContinue
if ($store) { foreach($s in $store){ Info("Running: " + $s.ProcessName) } }
try { $geo = (Get-WinHomeLocation).GeoId; Info("Region (GeoId): $geo") } catch {}
try { Info("System locale: " + (Get-WinSystemLocale).Name) } catch {}

Write-Host "`n========================= VERDICT =========================" -ForegroundColor Cyan
if ($verdict.Count -eq 0) {
  Write-Host "  No obvious cause found. If it persists: run wsreset.exe (Store cache reset)" -ForegroundColor White
  Write-Host "  and clear WebView2 cache under %LOCALAPPDATA%\Microsoft\Roblox*\EBWebView" -ForegroundColor White
  Write-Host "  Then send the full output above." -ForegroundColor White
} else {
  $i = 1
  foreach ($v in $verdict) { Write-Host ("  $i) " + $v) -ForegroundColor White; $i++ }
}
Write-Host "===========================================================`n" -ForegroundColor Cyan
