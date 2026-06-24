# b2_login_inject.ps1 -- B2 Stage 2: log into the buyer's Roblox account, then inject the
# resulting .ROBLOSECURITY into the Roblox app's WebView2 (recipient binding).
#
# Flow: buyer_login.py (real Chrome via Selenium; solves PoW + transparent Arkose itself)
#       -> .ROBLOSECURITY  ->  inject_cookie.ps1 (CDP Network.setCookie into the app WebView2)
#       -> the app is now logged in as the BUYER, so purchased Robux go to that account.
#
# RUN ON THE REAL Windows machine (where the Roblox app opens, NOT the dev VM).
# Keep buyer_login.py and inject_cookie.ps1 in the SAME folder.
# Deps: Python 3 + Chrome + selenium (the script pip-installs selenium).
#
#   powershell -ExecutionPolicy Bypass -File b2_login_inject.ps1 -Username "<roblox-login>" -Password "<roblox-password>"
#
# A Chrome window opens for login. If a captcha/2FA appears, solve it in that window; the script waits.
# ASCII-only on purpose (Windows PowerShell 5.1 mangles UTF-8 .ps1 without BOM).
param(
  [Parameter(Mandatory = $true)][string]$Username,
  [Parameter(Mandatory = $true)][string]$Password,
  [int]$Port = 9222,
  [int]$LoginTimeout = 150
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
function Info($m){ Write-Host ("  [..]   " + $m) -ForegroundColor Gray }
function Pass($m){ Write-Host ("  [OK]   " + $m) -ForegroundColor Green }
function Fail($m){ Write-Host ("  [FAIL] " + $m) -ForegroundColor Red }

$login = Join-Path $here "buyer_login.py"
$inject = Join-Path $here "inject_cookie.ps1"
if (-not (Test-Path $login))  { Fail("buyer_login.py not found next to this script - copy it here"); exit 1 }
if (-not (Test-Path $inject)) { Fail("inject_cookie.ps1 not found next to this script - copy it here"); exit 1 }

Write-Host "`n===== 1. Dependencies =====" -ForegroundColor Cyan
try { python --version 2>$null | Out-Null; if ($LASTEXITCODE -ne 0) { throw } } catch { Fail("Python not in PATH. Install Python 3 (check Add to PATH)."); exit 1 }
python -c "import selenium" 2>$null
if ($LASTEXITCODE -ne 0) { Info("installing selenium..."); python -m pip install --quiet selenium }
Pass("python + selenium ready (Chrome must be installed)")

Write-Host "`n===== 2. Roblox login (a Chrome window will open) =====" -ForegroundColor Cyan
Info("logging in as @$Username - progress from buyer_login shows below; can take up to ${LoginTimeout}s. Watch the Chrome window; solve captcha/2FA there if shown. DO NOT close Chrome.")
# buyer_login.py logs progress to stderr and prints the result JSON to stdout (last line).
# Capture stdout to a temp file so the JSON is clean; let stderr stream to the console (visible progress).
$prevEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
$tmp = [System.IO.Path]::GetTempFileName()
& python $login --username $Username --password $Password --wait --timeout $LoginTimeout 1>$tmp
$ErrorActionPreference = $prevEAP
$out = Get-Content $tmp -Raw -ErrorAction SilentlyContinue
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
$jsonLine = (($out -split "`n") | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1)
if (-not $jsonLine) { Fail("buyer_login.py returned no JSON. Output:`n$out"); exit 1 }
try { $res = $jsonLine | ConvertFrom-Json } catch { Fail("could not parse JSON: $jsonLine"); exit 1 }

if (-not $res.ok -or -not $res.roblosecurity) {
  Fail("login not completed: ok=$($res.ok) needs=$($res.needs) error=$($res.error)")
  Write-Host "  If needs=captcha/2fa - re-run and solve the challenge in the Chrome window." -ForegroundColor Yellow
  exit 2
}
$acc = $res.account
Pass("logged in as @$($acc.name) (id=$($acc.id)) - got .ROBLOSECURITY (len=$($res.roblosecurity.Length))")

Write-Host "`n===== 3. Inject cookie into the app WebView (CDP) =====" -ForegroundColor Cyan
Info("passing the cookie to inject_cookie.ps1 -> the app will be logged in as @$($acc.name)")
& $inject -Cookie $res.roblosecurity -Port $Port

Write-Host "`n===== DONE =====" -ForegroundColor Cyan
Write-Host "  Check the Roblox app window: the Robux page should be logged in as @$($acc.name) (id=$($acc.id))." -ForegroundColor White
Write-Host "  If so, the recipient is bound via the injected cookie. Next: Stage 3 (drive the Buy click)." -ForegroundColor White
Write-Host "  Remove the debug override after testing:  powershell -ExecutionPolicy Bypass -File inject_cookie.ps1 -Cleanup" -ForegroundColor White
