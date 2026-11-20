param(
  [Parameter(Mandatory = $true)][string]$Port,
  [int]$Baud = 115200
)
# Bridges ScareBooth (stdin/stdout) and the ScareBooth Lights box (USB serial).
#   stdin : "SEND <command>" lines, or "QUIT"
#   stdout: "OPEN <port>", "RX <line from the box>", "ERR <message>", "CLOSED"
$ErrorActionPreference = 'Stop'
try {
  $sp = New-Object System.IO.Ports.SerialPort $Port, $Baud, ([System.IO.Ports.Parity]::None), 8, ([System.IO.Ports.StopBits]::One)
  $sp.NewLine = "`n"
  $sp.DtrEnable = $false
  $sp.RtsEnable = $false
  $sp.ReadTimeout = 200
  $sp.WriteTimeout = 1000
  $sp.Open()
} catch {
  [Console]::Out.WriteLine("ERR " + $_.Exception.Message)
  [Console]::Out.Flush()
  exit 1
}
[Console]::Out.WriteLine("OPEN $Port")
[Console]::Out.Flush()

$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$pending = $stdin.ReadLineAsync()
$rx = ''
try {
  while ($true) {
    # commands from ScareBooth
    if ($pending.IsCompleted) {
      $cmd = $pending.Result
      if ($null -eq $cmd -or $cmd -eq 'QUIT') { break }
      if ($cmd.StartsWith('SEND ')) { $sp.Write($cmd.Substring(5) + "`n") }
      $pending = $stdin.ReadLineAsync()
      continue
    }
    # replies from the box
    if ($sp.BytesToRead -gt 0) {
      $rx += $sp.ReadExisting()
      while ($rx.Contains("`n")) {
        $i = $rx.IndexOf("`n")
        $line = $rx.Substring(0, $i).TrimEnd("`r")
        $rx = $rx.Substring($i + 1)
        if ($line.Length -gt 0) { [Console]::Out.WriteLine("RX " + $line); [Console]::Out.Flush() }
      }
      continue
    }
    Start-Sleep -Milliseconds 3
  }
} catch {
  [Console]::Out.WriteLine("ERR " + $_.Exception.Message)
  [Console]::Out.Flush()
} finally {
  try { $sp.Close() } catch {}
  [Console]::Out.WriteLine("CLOSED")
  [Console]::Out.Flush()
}
