#requires -RunAsAdministrator
<#
  test_a_robux.ps1 -- TEST A launcher: does Robux land on an ARBITRARY userId
  (one NOT logged into the Roblox MS Store app)?

  It wraps run_msstore_capture.ps1 with -OverrideUserId: during a real 80-Robux
  purchase the capture addon rewrites publisherUserId (the recipient) to your
  target. You buy while logged in as account X; Robux must arrive on the target.

  NEEDED IN THE SAME FOLDER (download all three from /download):
    - test_a_robux.ps1            (this file)
    - run_msstore_capture.ps1     (capture launcher)
    - capture_msstore_app.py      (mitmproxy addon)
  Requires Python 3 in PATH. Run AS ADMINISTRATOR:
    powershell -ExecutionPolicy Bypass -File test_a_robux.ps1 -RecipientUserId 5304760791

  Buys nothing by itself -- you make one real $0.99 purchase inside the Roblox app.
#>
param(
  [string]$RecipientUserId = "",
  [string]$LoggedInUserId  = ""
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $here "run_msstore_capture.ps1"
$addon    = Join-Path $here "capture_msstore_app.py"

function Die($m){ Write-Host $m -ForegroundColor Red; exit 1 }

if (-not (Test-Path $launcher)) { Die("Missing run_msstore_capture.ps1 in this folder. Download it from /download.") }
if (-not (Test-Path $addon))    { Die("Missing capture_msstore_app.py in this folder. Download it from /download.") }

while (-not $RecipientUserId) {
  $RecipientUserId = Read-Host "Recipient Roblox userId (the account NOT logged into the app)"
}
if ($RecipientUserId -notmatch '^\d+$') { Die("RecipientUserId must be digits only (Roblox userId).") }

Write-Host ""
Write-Host "================= TEST A: arbitrary recipient =================" -ForegroundColor Cyan
Write-Host "  Recipient (override) : $RecipientUserId   <- must NOT be logged into the app"
if ($LoggedInUserId) { Write-Host "  Logged-in account X  : $LoggedInUserId   <- the one you buy under" }
Write-Host ""
Write-Host "  STEP 0 (do this NOW, before buying):" -ForegroundColor Yellow
Write-Host "    Log the Roblox MS Store app into a DIFFERENT account than $RecipientUserId."
Write-Host "    Record both balances first (open each account's profile or):"
Write-Host "      https://www.roblox.com/users/$RecipientUserId/profile   (recipient, should be LOGGED OUT here)"
if ($LoggedInUserId) { Write-Host "      https://www.roblox.com/users/$LoggedInUserId/profile   (logged-in X)" }
Write-Host ""
Write-Host "  The capture window opens next. When it says 'PEREHVAT IDET' / capture is on:" -ForegroundColor Yellow
Write-Host "    1) In the Roblox app buy 80 Robux (pay with Microsoft balance)."
Write-Host "    2) White screen on payment is OK -- close it."
Write-Host "    3) Come back here and press Ctrl+C to stop + auto-send the report."
Write-Host ""
Write-Host "  STEP after (verdict):" -ForegroundColor Yellow
Write-Host "    Wait ~10-15s, reopen the store, then check balances:"
Write-Host "      +80 on RECIPIENT $RecipientUserId (logged-out target)  => TEST A PASSED: any userId works."
Write-Host "      +80 on the LOGGED-IN account instead                   => recipient is tied to app login."
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host ""
Read-Host "Press Enter to launch capture with override -> $RecipientUserId (Ctrl+C later to stop)" | Out-Null

& $launcher -OverrideUserId $RecipientUserId
