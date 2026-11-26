param(
  [Parameter(Mandatory = $true)][string]$Image,
  [string]$Printer = '',
  [ValidateSet('4x6-double', '4x6-single', '2x6')][string]$Layout = '4x6-double',
  [int]$Sheets = 1,
  [string]$JobName = 'ScareBooth',
  # Fine-tuning for printers that don't print exactly where the page says (e.g. DNP borderless):
  # + moves the picture right / down, in millimetres; ScalePct shrinks or grows it around the centre.
  [double]$OffsetXmm = 0,
  [double]$OffsetYmm = 0,
  [double]$ScalePct = 100,
  # Safe margin: borderless printers trim about 1-2 mm off every edge. The strip is shrunk just enough to keep
  # this many mm clear at the top and bottom, and the thin gap is filled with a blurred copy of the strip
  # (so there are no white lines). 0 = off.
  [double]$SafeMm = 0,
  # Each strip on its own (4x6-double: left = the strip on the left half, right = the right half; other layouts use
  # the left values). Moves in mm (+ = right / down) and size in %, around the strip's own centre. A strip never
  # crosses the printer's middle cut: it is clipped to its own half, and any gap is filled with the blurred copy.
  [double]$LeftXmm = 0, [double]$LeftYmm = 0, [double]$LeftScalePct = 100,
  [double]$RightXmm = 0, [double]$RightYmm = 0, [double]$RightScalePct = 100
)
# Sends a ScareBooth strip straight to a Windows printer (no dialog, no browser).
# Prints "OK <printer name>" on success, or "ERROR: <reason>" and exits 1.
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing
  if (-not (Test-Path -LiteralPath $Image)) { throw "Image not found: $Image" }
  $script:img = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Image).Path)
  # a very small copy of the strip: drawn stretched it becomes a soft blur used to fill the safe margin
  $script:blur = $null
  $script:blurAttr = $null
  $perStrip = ($LeftXmm -ne 0) -or ($LeftYmm -ne 0) -or ($LeftScalePct -ne 100) -or ($RightXmm -ne 0) -or ($RightYmm -ne 0) -or ($RightScalePct -ne 100)
  if (($SafeMm -gt 0) -or $perStrip) {
    $script:blur = New-Object System.Drawing.Bitmap 16, 48
    $bg = [System.Drawing.Graphics]::FromImage($script:blur)
    $bg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $bg.DrawImage($script:img, 0, 0, 16, 48)
    $bg.Dispose()
    $script:blurAttr = New-Object System.Drawing.Imaging.ImageAttributes
    $script:blurAttr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)   # no dark fringe at the edges
  }

  $doc = New-Object System.Drawing.Printing.PrintDocument
  $doc.DocumentName = $JobName
  if ($Printer) { $doc.PrinterSettings.PrinterName = $Printer }
  if (-not $doc.PrinterSettings.IsValid) { throw "Printer '$($doc.PrinterSettings.PrinterName)' was not found. Check the name in the ScareBooth console." }
  # StandardPrintController = no "Printing page 1 of 1" pop-up
  $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController

  # Pick the matching paper size if the driver offers it (sizes are in 1/100 inch).
  # DNP DS-RX1HS / DS620 / DS40: the 2-inch cut only works with the "PR (4x6)" or "(6x4)" paper size,
  # so those names are preferred. PR (4x6) is a little over 4x6 (105 x 156 mm), hence the 20 tolerance.
  $wantW = 400; if ($Layout -eq '2x6') { $wantW = 200 }
  $wantH = 600
  $match = $null
  $sizes = @($doc.PrinterSettings.PaperSizes)
  if ($Layout -ne '2x6') {
    foreach ($pat in @('^\s*PR\s*\(?\s*4\s*x\s*6\s*\)?\s*$', '^\s*\(?\s*6\s*x\s*4\s*\)?\s*$')) {
      if (-not $match) { $match = $sizes | Where-Object { $_.PaperName -match $pat } | Select-Object -First 1 }
    }
  } else {
    $match = $sizes | Where-Object { $_.PaperName -match '^\s*\(?\s*(2\s*x\s*6|6\s*x\s*2)' } | Select-Object -First 1
  }
  if (-not $match) {
    foreach ($ps in $sizes) {
      $fits = ([math]::Abs($ps.Width - $wantW) -le 20 -and [math]::Abs($ps.Height - $wantH) -le 20) -or
              ([math]::Abs($ps.Width - $wantH) -le 20 -and [math]::Abs($ps.Height - $wantW) -le 20)
      if ($fits) { $match = $ps; break }
    }
  }
  if ($match) { $doc.DefaultPageSettings.PaperSize = $match }
  $doc.DefaultPageSettings.Landscape = $false
  $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
  $doc.OriginAtMargins = $false

  $script:remaining = [math]::Max(1, $Sheets)
  $script:layout = $Layout

  $doc.add_PrintPage({
    param($src, $e)
    $g = $e.Graphics
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $pw = [single]$e.PageBounds.Width; $ph = [single]$e.PageBounds.Height
    # Graphics start at the printable area: shift back by the hard margins to use the whole sheet.
    $g.TranslateTransform(-[single]$e.PageSettings.HardMarginX, -[single]$e.PageSettings.HardMarginY)
    # Lay out in portrait; rotate if the driver's page is landscape.
    if ($pw -gt $ph) {
      $g.TranslateTransform($pw, 0)
      $g.RotateTransform(90)
      $W = $ph; $H = $pw
    } else { $W = $pw; $H = $ph }
    $g.Clear([System.Drawing.Color]::White)
    # position fine-tuning (page units are 1/100 inch): scale around the centre, then shift
    $k = [single]($ScalePct / 100.0)
    $g.TranslateTransform([single]($OffsetXmm / 25.4 * 100), [single]($OffsetYmm / 25.4 * 100))
    $g.TranslateTransform($W / 2, $H / 2); $g.ScaleTransform($k, $k); $g.TranslateTransform(-$W / 2, -$H / 2)
    switch ($script:layout) {
      '4x6-double' { $rects = @((New-Object System.Drawing.RectangleF(0, 0, ($W / 2), $H)), (New-Object System.Drawing.RectangleF(($W / 2), 0, ($W / 2), $H))) }
      '4x6-single' { $sw = $H / 3; $rects = @((New-Object System.Drawing.RectangleF((($W - $sw) / 2), 0, $sw, $H))) }
      default      { $rects = @((New-Object System.Drawing.RectangleF(0, 0, $W, $H))) }
    }
    $mmU = [single](100 / 25.4)   # 1 mm in page units (1/100 inch)
    for ($i = 0; $i -lt $rects.Count; $i++) {
      $r = $rects[$i]
      if (-not $script:blur) { $g.DrawImage($script:img, $r); continue }
      if ($i -eq 0) { $dx = $LeftXmm; $dy = $LeftYmm; $sp = $LeftScalePct } else { $dx = $RightXmm; $dy = $RightYmm; $sp = $RightScalePct }
      $state = $g.Save()
      $g.SetClip($r)   # this strip stays on its own half of the sheet
      # 1) soft background over the whole strip area
      $dest = New-Object System.Drawing.Rectangle ([int][math]::Floor($r.X)), ([int][math]::Floor($r.Y)), ([int][math]::Ceiling($r.Width)), ([int][math]::Ceiling($r.Height))
      $g.DrawImage($script:blur, $dest, 0, 0, 16, 48, [System.Drawing.GraphicsUnit]::Pixel, $script:blurAttr)
      # 2) the sharp strip: shrunk so $SafeMm stays clear at top and bottom (same shape), then this strip's own size and move
      $m = [single]([math]::Max(0, $SafeMm) * $mmU)
      $s = [single](($r.Height - 2 * $m) / $r.Height) * [single]($sp / 100.0)
      $iw = $r.Width * $s; $ih = $r.Height * $s
      $x = $r.X + ($r.Width - $iw) / 2 + [single]($dx * $mmU)
      $y = $r.Y + ($r.Height - $ih) / 2 + [single]($dy * $mmU)
      $g.DrawImage($script:img, (New-Object System.Drawing.RectangleF($x, $y, $iw, $ih)))
      $g.Restore($state)
    }
    $script:remaining--
    $e.HasMorePages = ($script:remaining -gt 0)
  })

  $doc.Print()
  $script:img.Dispose()
  if ($script:blur) { $script:blur.Dispose() }
  $paperName = '(driver default)'; if ($match) { $paperName = $match.PaperName }
  Write-Output ("OK " + $doc.PrinterSettings.PrinterName + " | paper: " + $paperName)
  exit 0
} catch {
  Write-Output ("ERROR: " + $_.Exception.Message)
  exit 1
}
