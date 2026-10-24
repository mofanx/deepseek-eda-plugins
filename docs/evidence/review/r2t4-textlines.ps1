# r2t4: find the text lines first (black row runs), then segment each line by column.
# No guessed y windows: within y 778-798 the four text lines are discovered, not assumed.
# Read-only.
param(
  [string]$Png = 'D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r2t1-w1-frame.png',
  [double]$OriginX = 200,
  [double]$OriginY = 672,
  [double]$Scale = 8.25,
  [double]$Y0 = 778,
  [double]$Y1 = 798,
  [string]$OutFile = 'D:\projects\nodejs\deepseek-eda-plugins\.tmp-r2t4\textlines.json'
)
Add-Type -AssemblyName System.Drawing
$b = [System.Drawing.Bitmap]::FromFile($Png)
function IsBlack($c) { return ($c.R -lt 110 -and $c.G -lt 110 -and $c.B -lt 110) }

$py0 = [int](($Y0 - $OriginY) * $Scale)
$py1 = [int](($Y1 - $OriginY) * $Scale)

# black pixel count per row
$rowCounts = @{}
for ($y = $py0; $y -le $py1; $y++) {
  $n = 0
  for ($x = 0; $x -lt $b.Width; $x++) { if (IsBlack ($b.GetPixel($x, $y))) { $n++ } }
  $rowCounts[$y] = $n
}

# contiguous row runs (a text line), gap <= 2 px
$lines = New-Object System.Collections.ArrayList
$cur = $null
for ($y = $py0; $y -le $py1; $y++) {
  if ($rowCounts[$y] -gt 0) {
    if ($null -eq $cur -or $y -gt $cur.y1 + 2) {
      $cur = [pscustomobject]@{ y0 = $y; y1 = $y }
      [void]$lines.Add($cur)
    } else { $cur.y1 = $y }
  }
}

$out = New-Object System.Collections.ArrayList
foreach ($ln in $lines) {
  if ($ln.y1 - $ln.y0 -lt 3) { continue }
  $runs = New-Object System.Collections.ArrayList
  $run = $null
  for ($x = 0; $x -lt $b.Width; $x++) {
    $n = 0
    for ($y = $ln.y0; $y -le $ln.y1; $y++) { if (IsBlack ($b.GetPixel($x, $y))) { $n++ } }
    if ($n -gt 0) {
      if ($null -eq $run) { $run = [pscustomobject]@{ x0 = $x; x1 = $x } } else { $run.x1 = $x }
    } elseif ($null -ne $run -and $x -gt $run.x1 + 2) { [void]$runs.Add($run); $run = $null }
  }
  if ($null -ne $run) { [void]$runs.Add($run) }

  $glyphs = New-Object System.Collections.ArrayList
  foreach ($r in $runs) {
    $w = ($r.x1 - $r.x0) / $Scale
    if ($w -lt 0.6) { continue }
    [void]$glyphs.Add([pscustomobject]@{
      x0 = [Math]::Round($OriginX + $r.x0 / $Scale, 2)
      x1 = [Math]::Round($OriginX + $r.x1 / $Scale, 2)
      w = [Math]::Round($w, 2)
    })
  }
  [void]$out.Add([pscustomobject]@{
    y0 = [Math]::Round($OriginY + $ln.y0 / $Scale, 2)
    y1 = [Math]::Round($OriginY + $ln.y1 / $Scale, 2)
    h = [Math]::Round(($ln.y1 - $ln.y0) / $Scale, 2)
    glyphCount = $glyphs.Count
    glyphs = @($glyphs)
  })
}

$b.Dispose()
$result = [pscustomobject]@{ png = $Png; window = @{ y0 = $Y0; y1 = $Y1 }; lineCount = $out.Count; lines = @($out) }
$result | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $OutFile
Write-Output ("lines=" + $out.Count)
