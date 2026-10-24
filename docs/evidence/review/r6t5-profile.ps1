param([string]$Png, [string]$Out)
# r6t5: character profile of the black pin-number glyph inside the MCU-34 crop.
# Read-only with respect to the editor: this reads a PNG and writes only $Out.
Add-Type -AssemblyName System.Drawing
$b = [System.Drawing.Bitmap]::FromFile($Png)
$W = $b.Width; $H = $b.Height
$cols = @()
for ($x = 0; $x -lt $W; $x++) {
  $n = 0; $ymin = $H; $ymax = -1
  for ($y = 0; $y -lt $H; $y++) {
    $c = $b.GetPixel($x, $y)
    if ($c.R -lt 110 -and $c.G -lt 110 -and $c.B -lt 110) {
      $n++
      if ($y -lt $ymin) { $ymin = $y }
      if ($y -gt $ymax) { $ymax = $y }
    }
  }
  $cols += [pscustomobject]@{ x = $x; n = $n; ymin = $ymin; ymax = $ymax }
}
$groups = @(); $cur = $null
foreach ($c in $cols) {
  if ($c.n -gt 0) {
    if ($null -eq $cur -or $c.x -gt $cur.x1 + 3) {
      if ($null -ne $cur) { $groups += $cur }
      $cur = [pscustomobject]@{ x0 = $c.x; x1 = $c.x; n = 0; ymin = $H; ymax = -1 }
    }
    $cur.x1 = $c.x; $cur.n += $c.n
    if ($c.ymin -lt $cur.ymin) { $cur.ymin = $c.ymin }
    if ($c.ymax -gt $cur.ymax) { $cur.ymax = $c.ymax }
  }
}
if ($null -ne $cur) { $groups += $cur }
$ascii = @()
for ($y = 25; $y -le 145; $y++) {
  $line = ''
  for ($x = 90; $x -le 390; $x += 2) {
    $c = $b.GetPixel($x, $y)
    if ($c.R -lt 110 -and $c.G -lt 110 -and $c.B -lt 110) { $line += '#' } else { $line += '.' }
  }
  $ascii += $line
}
$b.Dispose()
@{ image = @{ w = $W; h = $H }; groups = $groups; ascii = $ascii } |
  ConvertTo-Json -Depth 5 -Compress | Set-Content -Encoding utf8 $Out
