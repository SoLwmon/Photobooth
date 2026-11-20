# Lists USB serial (COM) ports as JSON: [{"port":"COM3","name":"USB-SERIAL CH340 (COM3)"}, ...]
$ErrorActionPreference = 'SilentlyContinue'
$ports = @([System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object -Unique)
$names = @{}
try {
  Get-CimInstance Win32_PnPEntity -Filter "Name LIKE '%(COM%'" | ForEach-Object {
    if ($_.Name -match '\((COM\d+)\)') { $names[$Matches[1]] = $_.Name }
  }
} catch {}
$list = @()
foreach ($p in $ports) {
  $n = $names[$p]
  # skip Bluetooth virtual ports: they can hang for a long time when opened
  if ($n -and $n -match 'Bluetooth') { continue }
  $list += [ordered]@{ port = $p; name = $(if ($n) { $n } else { 'Serial port' }) }
}
Write-Output (ConvertTo-Json -InputObject @($list) -Compress)
