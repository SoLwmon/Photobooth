param([int]$Port = 8080)
# Waits for the ScareBooth server, then opens:
#   - the booth display in a full-screen kiosk window (Chrome or Edge) with camera + sound pre-approved
#   - the operator console in the default browser
$ErrorActionPreference = 'SilentlyContinue'
$base = "http://localhost:$Port"

# 1) wait for the server (up to 30 s)
$up = $false
for ($i = 0; $i -lt 60; $i++) {
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$base/api/state" | Out-Null; $up = $true; break } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $up) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show("The ScareBooth server didn't start. Check the server window for an error message.", "ScareBooth") | Out-Null
  exit 1
}

# 2) find a Chromium browser
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$pref = "$env:SCAREBOOTH_BROWSER".ToLower()
$browser = $null; $isEdge = $false
if ($pref -eq 'edge' -and $edge) { $browser = $edge; $isEdge = $true }
elseif ($chrome) { $browser = $chrome }
elseif ($edge) { $browser = $edge; $isEdge = $true }

if (-not $browser) {
  Start-Process "$base/display"
  Start-Process "$base/admin"
  exit 0
}

# A dedicated browser profile so kiosk flags always apply (even if the browser is already open).
$profileDir = Join-Path $env:LOCALAPPDATA "ScareBooth\display-profile"
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

$flags = @(
  "--user-data-dir=`"$profileDir`"",
  "--no-first-run", "--no-default-browser-check",
  "--autoplay-policy=no-user-gesture-required",   # scare sound plays without a click
  "--use-fake-ui-for-media-stream",                # auto-approve the webcam permission prompt
  "--kiosk-printing",                              # print straight to the default printer, no dialog
  "--disable-features=Translate,TranslateUI",
  "--disable-session-crashed-bubble", "--noerrdialogs", "--disable-infobars",
  "--overscroll-history-navigation=0", "--disable-pinch"
)
if ($env:SCAREBOOTH_DISPLAY_POS) { $flags += "--window-position=$($env:SCAREBOOTH_DISPLAY_POS)" }
if ($env:SCAREBOOTH_NO_KIOSK -eq '1') {
  $flags += "--new-window"; $flags += "--app=$base/display"
} else {
  $flags += "--kiosk"
  if ($isEdge) { $flags += "--edge-kiosk-type=fullscreen" }
  $flags += "$base/display"
}
Start-Process -FilePath $browser -ArgumentList $flags

Start-Sleep -Seconds 2
Start-Process "$base/admin"
