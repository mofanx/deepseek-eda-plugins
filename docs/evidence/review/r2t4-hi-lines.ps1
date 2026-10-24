# r2t4: text-line discovery in PIXEL space on the high-resolution capture.
# At ~31 px/unit the pin name and the pin number of one row (4 units apart) are ~125 px
# apart, so the lines separate cleanly - which the 8.25 px/unit frames could not do.
# Read-only: reads one PNG, writes one JSON.
param(
  [string]$Png = 'D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r2t4-glyph-closeup.png',
  [int]$X0 = 40,
  [int]$X1 = 660,
  [int]$Y0 = 60,
  [int]$Y1 = 1700,
  [int]$RowMin = 8,
  [int]$GapPx = 6,
  [string]$OutFile = 'D:\projects\nodejs\deepseek-eda-plugins\.tmp-r2t4\hi-lines.json'
)
Add-Type -AssemblyName System.Drawing
$b = [System.Drawing.Bitmap]::FromFile($Png)
$W = $b.Width; $H = $b.Height
function IsBlack($c) { return ($c.R -lt 110 -and $c.G -lt 110 -and $c.B -lt 110) }

# black count per row inside the text window
$rc = @{}
for ($y = $Y0; $y -le $Y1; $y++) {
  $n = 0
  for ($x = $X0; $x -le $X1; $x++) { if (IsBlack ($b.GetPixel($x, $y))) { $n++ } }
  $rc[$y] = $n
}

# text lines: rows with at least RowMin black pixels, split on gaps > GapPx
$lines = New-Object System.Collections.ArrayList
$cur = $null
for ($y = $Y0; $y -le $Y1; $y++) {
  if ($rc[$y] -ge $RowMin) {
    if ($null -eq $cur -or $y -gt $cur.y1 + $GapPx) {
      $cur = [pscustomobject]@{ y0 = $y; y1 = $y }
      [void]$lines.Add($cur)
    } else { $cur.y1 = $y }
  }
}

$out = New-Object System.Collections.ArrayList
foreach ($ln in $lines) {
  if ($ln.y1 - $ln.y0 -lt 10) { continue }
  $runs = New-Object System.Collections.ArrayList
  $run = $null
  for ($x = $X0; $x -le $X1; $x++) {
    $n = 0
    for ($y = $ln.y0; $y -le $ln.y1; $y++) { if (IsBlack ($b.GetPixel($x, $y))) { $n++ } }
    if ($n -gt 0) {
      if ($null -eq $run) { $run = [pscustomobject]@{ x0 = $x; x1 = $x } } else { $run.x1 = $x }
    } elseif ($null -ne $run -and $x -gt $run.x1 + 3) { [void]$runs.Add($run); $run = $null }
  }
  if ($null -ne $run) { [void]$runs.Add($run) }

  $glyphs = New-Object System.Collections.ArrayList
  foreach ($r in $runs) { if (($r.x1 - $r.x0) -ge 4) { [void]$glyphs.Add([pscustomobject]@{ x0 = $r.x0; x1 = $r.x1; w = $r.x1 - $r.x0 + 1 }) } }
  [void]$out.Add([pscustomobject]@{
    y0 = $ln.y0; y1 = $ln.y1; h = $ln.y1 - $ln.y0
    glyphCount = $glyphs.Count; glyphs = @($glyphs)
  })
}

$b.Dispose()
$result = [pscustomobject]@{ png = $Png; window = @{ x0 = $X0; x1 = $X1; y0 = $Y0; y1 = $Y1 }; lineCount = $out.Count; lines = @($out) }
$result | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $OutFile
Write-Output ("lines=" + $out.Count)
