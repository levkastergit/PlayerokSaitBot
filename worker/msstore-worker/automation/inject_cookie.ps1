# inject_cookie.ps1 -- PROVE cookie injection into the Roblox MS Store app WebView2.
#
# Goal (milestone): set a .ROBLOSECURITY cookie into the app's WebView2 via CDP so the
# in-app purchase page is logged in as an ARBITRARY Roblox account, WITHOUT manually
# signing in. If Robux then land on that account, the swizzyer-style decoupling
# (funded MSA pays, injected cookie = recipient) is proven end-to-end.
#
# HOW: WebView2 honors --remote-debugging-port via the registry override
#   HKCU\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments\<hostExe>.
# We set it for every exe in the Roblox package, (re)launch the app, find the debug
# target on 127.0.0.1:PORT, and call Network.setCookie + Page.navigate over CDP.
#
# USAGE (run as your normal user; close the Roblox app first):
#   # 1) just test that the debug port comes up (no injection):
#   powershell -ExecutionPolicy Bypass -File inject_cookie.ps1
#   # 2) inject a cookie you already have (e.g. your 5304760791 .ROBLOSECURITY):
#   powershell -ExecutionPolicy Bypass -File inject_cookie.ps1 -Cookie "<.ROBLOSECURITY value>"
#
# Nothing is purchased here. After it loads logged-in, buy 80 Robux manually and check
# which account got them. To undo the debug-port override later: pass -Cleanup.
param(
  [string]$Cookie = "",
  [string]$CookieFile = "",
  [int]$Port = 9222,
  [string]$BuyUrl = "https://www.roblox.com/premium/windows/robux",
  [switch]$Cleanup
)
$ErrorActionPreference = "Stop"
# Cookie can be passed inline (-Cookie) OR read from a file (-CookieFile cookie.txt) — the latter
# avoids pasting a huge string into the command line (and the classic "left the placeholder" mistake).
if ($CookieFile) {
  if (-not (Test-Path $CookieFile)) { Write-Host "  [FAIL] CookieFile not found: $CookieFile" -ForegroundColor Red; exit 1 }
  $Cookie = ((Get-Content $CookieFile -Raw) -replace '\s+', '').Trim()
}
if ($Cookie -and ($Cookie -notmatch 'ROBLOSECURITY|_\|WARNING|^_\|' ) -and ($Cookie.Length -lt 200)) {
  Write-Host "  [FAIL] -Cookie doesn't look like a real .ROBLOSECURITY (too short / placeholder). Paste the real value or use -CookieFile." -ForegroundColor Red
  exit 1
}
function Pass($m){ Write-Host ("  [OK]   " + $m) -ForegroundColor Green }
function Warn($m){ Write-Host ("  [WARN] " + $m) -ForegroundColor Yellow }
function Fail($m){ Write-Host ("  [FAIL] " + $m) -ForegroundColor Red }
function Info($m){ Write-Host ("  [..]   " + $m) -ForegroundColor Gray }

$regBase = "HKCU:\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments"

# ---- locate Roblox package + its executables ----
Write-Host "`n===== 1. Locate Roblox MS Store app =====" -ForegroundColor Cyan
$pkg = Get-AppxPackage | Where-Object { $_.Name -match "Roblox" } | Select-Object -First 1
if (-not $pkg) { Fail("Roblox MS Store app not installed (Get-AppxPackage *Roblox* empty)."); exit 1 }
Pass("package: $($pkg.Name)  PFN=$($pkg.PackageFamilyName)")
$manifestPath = Join-Path $pkg.InstallLocation "AppxManifest.xml"
$appId = $null; $exeNames = @()
try {
  [xml]$mf = Get-Content $manifestPath
  $apps = $mf.Package.Applications.Application
  foreach ($a in @($apps)) {
    if (-not $appId) { $appId = $a.Id }
    if ($a.Executable) { $exeNames += (Split-Path $a.Executable -Leaf) }
  }
} catch { Warn("could not parse manifest: $_") }
# add common WebView2 host exe guesses
$exeNames += @("Windows10Universal.exe","RobloxPlayerBeta.exe","RobloxApp.exe","eurotrucks2.exe")
$exeNames = $exeNames | Where-Object { $_ } | Sort-Object -Unique
Info("AppId: $appId")
Info("host exe candidates: $($exeNames -join ', ')")
$launchAumid = "$($pkg.PackageFamilyName)!$appId"

# ---- cleanup mode ----
if ($Cleanup) {
  Write-Host "`n===== Cleanup: remove debug-port override =====" -ForegroundColor Cyan
  if (Test-Path $regBase) { Remove-Item $regBase -Recurse -Force; Pass("removed $regBase") } else { Info("nothing to remove") }
  exit 0
}

# ---- set WebView2 remote-debugging override for every candidate exe ----
Write-Host "`n===== 2. Enable WebView2 remote debugging (registry override) =====" -ForegroundColor Cyan
New-Item -Path $regBase -Force | Out-Null
$arg = "--remote-debugging-port=$Port --remote-allow-origins=*"
foreach ($exe in $exeNames) {
  New-ItemProperty -Path $regBase -Name $exe -Value $arg -PropertyType String -Force | Out-Null
}
Pass("set AdditionalBrowserArguments = '$arg' for $($exeNames.Count) exe name(s)")
Warn("this affects WebView2 only for those host exes; remove later with -Cleanup")

# ---- (re)launch the app so WebView2 picks up the args ----
Write-Host "`n===== 3. Relaunch Roblox app =====" -ForegroundColor Cyan
Get-Process msedgewebview2,RobloxPlayerBeta,Windows10Universal -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process "shell:AppsFolder\$launchAumid"
Info("launched shell:AppsFolder\$launchAumid -- wait for it to open")

# ---- poll the CDP HTTP endpoint for targets ----
Write-Host "`n===== 4. Wait for debug port $Port =====" -ForegroundColor Cyan
$targets = $null
for ($i=0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 2
  try {
    $json = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 4
    if ($json) { $targets = @($json); break }
  } catch { }
  if ($i % 5 -eq 0) { Info("...still waiting ($([int]($i*2))s) -- open/navigate the app's store page") }
}
if (-not $targets) {
  Fail("Debug port $Port never responded. WebView2 did not honor the override for these exe names.")
  Warn("Next: while the app is open run -> Get-Process msedgewebview2 | Select Id,Path  AND  Get-CimInstance Win32_Process | Where-Object Name -eq msedgewebview2.exe | Select ProcessId,ParentProcessId")
  Warn("     the PARENT process of msedgewebview2 is the host exe; add its name and re-run.")
  exit 2
}
Pass("debug port live -- $($targets.Count) target(s):")
foreach ($t in $targets) { Info("  [$($t.type)] $($t.title)  ->  $($t.url)") }

# pick a page target (prefer roblox.com)
$page = $targets | Where-Object { $_.type -eq "page" -and $_.url -match "roblox\.com" } | Select-Object -First 1
if (-not $page) { $page = $targets | Where-Object { $_.type -eq "page" } | Select-Object -First 1 }
if (-not $page) { Fail("no 'page' target to drive"); exit 3 }
Pass("driving target: $($page.url)")

if (-not $Cookie) {
  Write-Host "`n[i] No -Cookie given: debug port works. Re-run with -Cookie '<.ROBLOSECURITY>' to inject." -ForegroundColor Yellow
  exit 0
}

# ---- minimal CDP over WebSocket (.NET ClientWebSocket, no extra deps) ----
Write-Host "`n===== 5. Inject .ROBLOSECURITY via CDP =====" -ForegroundColor Cyan
Add-Type -AssemblyName System.Net.WebSockets 2>$null | Out-Null
$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ct = [System.Threading.CancellationToken]::None
$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $ct).GetAwaiter().GetResult()
$script:cdpId = 0
function Cdp($method, $params) {
  $script:cdpId++
  $msg = @{ id = $script:cdpId; method = $method; params = $params } | ConvertTo-Json -Depth 8 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($msg)
  $seg = [System.ArraySegment[byte]]::new($bytes)
  $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).GetAwaiter().GetResult() | Out-Null
  # read until we get a frame with our id
  $buf = New-Object byte[] 65536
  for ($k=0; $k -lt 50; $k++) {
    $sb = New-Object System.Text.StringBuilder
    do {
      $seg2 = [System.ArraySegment[byte]]::new($buf)
      $res = $ws.ReceiveAsync($seg2, $ct).GetAwaiter().GetResult()
      [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf,0,$res.Count))
    } while (-not $res.EndOfMessage)
    $obj = $sb.ToString() | ConvertFrom-Json
    if ($obj.id -eq $script:cdpId) { return $obj }
  }
  return $null
}

[void](Cdp "Network.enable" @{})
$ck = @{
  name     = ".ROBLOSECURITY"
  value    = $Cookie
  domain   = ".roblox.com"
  path     = "/"
  secure   = $true
  httpOnly = $true
}
$r = Cdp "Network.setCookie" $ck
if ($r.result.success -eq $true -or $r.result -ne $null) { Pass("Network.setCookie sent (result: $($r.result | ConvertTo-Json -Compress))") }
else { Warn("setCookie response: $($r | ConvertTo-Json -Compress)") }

[void](Cdp "Page.enable" @{})
[void](Cdp "Page.navigate" @{ url = $BuyUrl })
Pass("navigated to $BuyUrl")
$ws.Dispose()

Write-Host "`n===== DONE =====" -ForegroundColor Cyan
Write-Host "  The app's WebView should now show Robux page logged in as the cookie's account." -ForegroundColor White
Write-Host "  Verify the username/avatar in the app. If correct -> buy 80 Robux and confirm" -ForegroundColor White
Write-Host "  which account got them. Remove the debug override afterwards:" -ForegroundColor White
Write-Host "    powershell -ExecutionPolicy Bypass -File inject_cookie.ps1 -Cleanup" -ForegroundColor White
