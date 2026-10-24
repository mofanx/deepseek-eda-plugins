# r2t4: row-band + glyph segmentation inside a text window (x 40..660, y 60..1700).
# Read-only. Reads one PNG, writes one JSON.
param(
  [string]$Png = 'D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r2t4-glyph-closeup.png',
  [string]$OutFile = 'D:\projects\nodejs\deepseek-eda-plugins\.tmp-r2t4\segments2.json'
)
Add-Type -AssemblyName System.Drawing
$b = [System.Drawing.Bitmap]::FromFile($Png)
$W = $b.Width; $H = $b.Height
$X0 = 40; $X1 = 660; $Y0 = 60; $Y1 = [Math]::Min(1700, $H - 1)

function IsBlack($c) { return ($c.R -lt 110 -and $c.G -lt 110 -and $c.B -lt 110) }
function IsBlue($c) { return ($c.B -gt $c.R + 40 -and $c.B -gt $c.G + 40) }

# row profile inside the text window
$rows = New-Object System.Collections.ArrayList
for ($y = $Y0; $y -le $Y1; $y++) {
  $nb = 0; $nu = 0
  for ($x = $X0; $x -le $X1; $x++) {
    $c = $b.GetPixel($x, $y)
    if (IsBlack $c) { $nb++ } elseif (IsBlue $c) { $nu++ }
  }
  [void]$rows.Add([pscustomobject]@{ y = $y; black = $nb; blue = $nu })
}

# bands: rows with a meaningful amount of black, gaps > 8 px split them
$bands = New-Object System.Collections.ArrayList
$cur = $null
foreach ($r in $rows) {
  if ($r.black -le 60) { continue }
  if ($null -eq $cur -or $r.y -gt $cur.y1 + 8) {
    $cur = [pscustomobject]@{ y0 = $r.y; y1 = $r.y }
    [void]$bands.Add($cur)
  } else { $cur.y1 = $r.y }
}

function ColumnRuns([int]$y0, [int]$y1, [string]$colour) {
  $res = New-Object System.Collections.ArrayList
  $run = $null
  for ($x = $X0; $x -le $X1; $x++) {
    $n = 0; $ymin = $H; $ymax = -1
    for ($y = $y0; $y -le $y1; $y++) {
      $c = $b.GetPixel($x, $y)
      $hit = $false
      if ($colour -eq 'black') { $hit = IsBlack $c } else { $hit = IsBlue $c }
      if ($hit) { $n++; if ($y -lt $ymin) { $ymin = $y }; if ($y -gt $ymax) { $ymax = $y } }
    }
    if ($n -gt 0) {
      if ($null -eq $run) { $run = [pscustomobject]@{ x0 = $x; x1 = $x; ymin = $ymin; ymax = $ymax; n = $n } }
      else { $run.x1 = $x; $run.ymin = [Math]::Min($run.ymin, $ymin); $run.ymax = [Math]::Max($run.ymax, $ymax); $run.n += $n }
    } elseif ($null -ne $run -and $x -gt $run.x1 + 2) {
      [void]$res.Add($run); $run = $null
    }
  }
  if ($null -ne $run) { [void]$res.Add($run) }
  return $res
}

$rowsOut = New-Object System.Collections.ArrayList
foreach ($band in $bands) {
  $blk = @(ColumnRuns $band.y0 $band.y1 'black' | Where-Object { ($_.x1 - $_.x0) -ge 3 })
  $blu = @(ColumnRuns $band.y0 $band.y1 'blue' | Where-Object { ($_.x1 - $_.x0) -ge 3 })
  [void]$rowsOut.Add([pscustomobject]@{
    y0 = $band.y0; y1 = $band.y1; h = $band.y1 - $band.y0
    blackCount = $blk.Count; black = $blk
    blueCount = $blu.Count; blue = $blu
  })
}

$b.Dispose()
$result = [pscustomobject]@{
  png = $Png; size = @{ w = $W; h = $H }; window = @{ x0 = $X0; x1 = $X1; y0 = $Y0; y1 = $Y1 }
  bandCount = $bands.Count; rows = @($rowsOut)
}
$result | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 $OutFile
Write-Output ("bands=" + $bands.Count)
