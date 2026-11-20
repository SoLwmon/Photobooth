# Lists installed Windows printers as JSON: {"default":"...","printers":["...", ...]}
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing
  $default = (New-Object System.Drawing.Printing.PrinterSettings).PrinterName
  $names = @()
  foreach ($p in [System.Drawing.Printing.PrinterSettings]::InstalledPrinters) { $names += [string]$p }
  $obj = [ordered]@{ default = $default; printers = $names }
  Write-Output (ConvertTo-Json -InputObject $obj -Compress)
} catch {
  Write-Output ('{"error":' + (ConvertTo-Json -InputObject $_.Exception.Message) + '}')
}
