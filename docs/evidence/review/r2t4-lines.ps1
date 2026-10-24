# r2t4: split the pressed row into its TWO text lines and segment each by column.
# A pin has a Pin Name (4 units below the number) and a Pin Number; in the 795 row they are
# 4 units apart and their glyph bands merge into one 4.36-tall blob. This separates them.
# Read-only.
param(
  [string]$Png = 'D:\projects\nodejs\deepseek-eda-plugins\docs\evidence\current\r2t1-w1-frame.png',
  [double]$OriginX = 200,
  [double]$OriginY = 672,
  [double]$Scale = 8.25,
  [string]$OutFile = 'D:\projects\nodejs\deepseek-eda-plugins\.tmp-r2t4\lines.json'
)
Add-Type -AssemblyName System.Drawing
$b = [System.Drawing.Bitmap]::FromFile($Png)

function IsBlack($c) { return ($c.R -lt 110 -and $c.G -lt 110 -and $c.B -lt 110) }

# unit-y window -> pixel rows
function Band([double]$u0, [double]$u1) { return @([int](($u0 - $OriginY) * $Scale), [int](($u1 - $OriginY) * $Scale)) }

function RunsInBand([double]$u0, [double]$u1) {
  $p = Band $u0 $u1
  $y0 = $p[0]; $y1 = $p[1]
  $res = New-Object System.Collections.ArrayList
  $run = $null
  for ($x = 0; $x -lt $b.Width; $x++) {
    $n = 0; $ymin = 99999; $ymax = -1
    for ($y = $y0; $y -le $y1; $y++) {
      $c = $b.GetPixel($x, $y)
      if (IsBlack $c) { $n++; if ($y -lt $ymin) { $ymin = $y }; if ($y -gt $ymax) { $ymax = $y } }
    }
    if ($n -gt 0) {
      if ($null -eq $run) { $run = [pscustomobject]@{ x0 = $x; x1 = $x; ymin = $ymin; ymax = $ymax } }
      else { $run.x1 = $x; $run.ymin = [Math]::Min($run.ymin, $ymin); $run.ymax = [Math]::Max($run.ymax, $ymax) }
    } elseif ($null -ne $run -and $x -gt $run.x1 + 2) { [void]$res.Add($run); $run = $null }
  }
  if ($null -ne $run) { [void]$res.Add($run) }
  return $res
}

function Describe($runs, [string]$tag) {
  $out = New-Object System.Collections.ArrayList
  foreach ($r in $runs) {
    $w = ($r.x1 - $r.x0) / $Scale
    if ($w -lt 0.6) { continue }   # single-pixel antialias specks are not glyphs
    [void]$out.Add([pscustomobject]@{
      tag = $tag
      x0 = [Math]::Round($OriginX + $r.x0 / $Scale, 2)
      x1 = [Math]::Round($OriginX + $r.x1 / $Scale, 2)
      w = [Math]::Round($w, 2)
      y0 = [Math]::Round($OriginY + $r.ymin / $Scale, 2)
      y1 = [Math]::Round($OriginY + $r.ymax / $Scale, 2)
    })
  }
  return $out
}

# row 795: Pin Name at y~790.08, Pin Number "31" at y~794.09
$name = Describe (RunsInBand 787.8 792.2) 'name-line'
$num = Describe (RunsInBand 792.6 796.9) 'number-line'

# row 785 for comparison: Pin Name PA11 at ~780.08, Pin Number "32" at ~784.09
$name2 = Describe (RunsInBand 778.0 782.2) 'row785-name'
$num2 = Describe (RunsInBand 782.6 786.9) 'row785-number'

$b.Dispose()
$result = [pscustomobject]@{
  png = $Png; origin = @{ x = $OriginX; y = $OriginY }; scale = $Scale
  row795 = @{ name = @($name); number = @($num) }
  row785 = @{ name = @($name2); number = @($num2) }
}
$result | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 $OutFile
Write-Output ("row795 name=" + $name.Count + " number=" + $num.Count + " | row785 name=" + $name2.Count + " number=" + $num2.Count)
