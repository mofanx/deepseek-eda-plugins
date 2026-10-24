# r2t4: segment the captured close-up by colour and by column runs.
# Read-only: reads one PNG, writes one JSON. No bridge, no document access.
param(
  [string]$Png = 'D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r2t4-glyph-closeup.png',
  [string]$Out = 'D:\projects\nodejs\deepseek-eda-plugins\.tmp-r2t4\segments.json'
)
Add-Type -AssemblyName System.Drawing
$b = [System.Drawing.Bitmap]::FromFile($Png)
$W = $b.Width; $H = $b.Height

function IsBlack($c) { return ($c.R -lt 110 -and $c.G -lt 110 -and $c.B -lt 110) }
function IsBlue($c) { return ($c.B -gt $c.R + 40 -and $c.B -gt $c.G + 40) }
function IsGreen($c) { return ($c.G -gt $c.R + 20 -and $c.G -gt $c.B + 20) }

# row profile
$rowInfo = New-Object System.Collections.ArrayList
for ($y = 0; $y -lt $H; $y++) {
  $nb = 0; $nu = 0; $ng = 0
  for ($x = 0; $x -lt $W; $x++) {
    $c = $b.GetPixel($x, $y)
    if (IsBlack $c) { $nb++ } elseif (IsBlue $c) { $nu++ } elseif (IsGreen $c) { $ng++ }
  }
  if ($nb -gt 0 -or $nu -gt 0 -or $ng -gt 0) { [void]$rowInfo.Add([pscustomobject]@{ y = $y; black = $nb; blue = $nu; green = $ng }) }
}

# contiguous row bands
$bands = New-Object System.Collections.ArrayList
$cur = $null
foreach ($r in $rowInfo | Where-Object { $_.black -gt 12 }) {
  if ($null -eq $cur -or $r.y -gt $cur.y1 + 4) {
    $cur = [pscustomobject]@{ y0 = $r.y; y1 = $r.y; black = 0; blue = 0; green = 0 }
    [void]$bands.Add($cur)
  } else { $cur.y1 = $r.y }
  $cur.black += $r.black; $cur.blue += $r.blue; $cur.green += $r.green
}

# column runs of one colour inside a y window
function ColumnRuns([int]$y0, [int]$y1, [string]$colour) {
  $runs = New-Object System.Collections.ArrayList
  $run = $null
  for ($x = 0; $x -lt $W; $x++) {
    $n = 0; $ymin = $H; $ymax = -1
    for ($y = $y0; $y -le $y1; $y++) {
      $c = $b.GetPixel($x, $y)
      $hit = $false
      switch ($colour) { 'black' { $hit = IsBlack $c } 'blue' { $hit = IsBlue $c } 'green' { $hit = IsGreen $c } }
      if ($hit) { $n++; if ($y -lt $ymin) { $ymin = $y }; if ($y -gt $ymax) { $ymax = $y } }
    }
    if ($n -gt 0) {
      if ($null -eq $run) { $run = [pscustomobject]@{ x0 = $x; x1 = $x; ymin = $ymin; ymax = $ymax; n = $n } }
      else { $run.x1 = $x; $run.ymin = [Math]::Min($run.ymin, $ymin); $run.ymax = [Math]::Max($run.ymax, $ymax); $run.n += $n }
    } elseif ($null -ne $run -and $x -gt $run.x1 + 2) {
      [void]$runs.Add($run); $run = $null
    }
  }
  if ($null -ne $run) { [void]$runs.Add($run) }
  return $runs
}

$rowsOut = New-Object System.Collections.ArrayList
foreach ($band in $bands) {
  if ($band.y1 - $band.y0 -lt 4) { continue }
  $black = ColumnRuns $band.y0 $band.y1 'black'
  $blue = ColumnRuns $band.y0 $band.y1 'blue'
  [void]$rowsOut.Add([pscustomobject]@{
    y0 = $band.y0; y1 = $band.y1
    blackGlyphs = @($black | Where-Object { ($_.x1 - $_.x0) -ge 3 })
    blueRuns = @($blue | Where-Object { ($_.x1 - $_.x0) -ge 3 })
  })
}

$b.Dispose()
$result = [pscustomobject]@{ png = $Png; size = @{ w = $W; h = $H }; bands = @($bands); rows = @($rowsOut) }
$result | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 $Out
Write-Output ("bands=" + $bands.Count + " rows=" + $rowsOut.Count + " -> " + $Out)
