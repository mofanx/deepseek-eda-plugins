param([string]$Context, [string]$OutDir)
# r6t5: derive the exact requested corridor and the glyph crop from the full-screen
# context. Read-only with respect to the editor: this only reads $Context and writes
# two PNG artifacts. The screen coordinates use the row-pitch calibration 25.9 px/unit:
#   corridor page x 214..252, y 787..797 -> x82,y887,984x259
#   glyph crop around white box x229.33..248.48 -> x450,y930,560x160
Add-Type -AssemblyName System.Drawing
$b = [System.Drawing.Bitmap]::FromFile($Context)
$specs = @(
  @{ file = 'r6t5-mcu34-corridor.png'; x = 82; y = 887; w = 984; h = 259 },
  @{ file = 'r6t5-mcu34-glyph-closeup.png'; x = 450; y = 930; w = 560; h = 160 }
)
foreach ($s in $specs) {
  $dst = Join-Path $OutDir $s.file
  $r = New-Object System.Drawing.Rectangle($s.x, $s.y, $s.w, $s.h)
  $c = $b.Clone($r, $b.PixelFormat)
  $c.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
  $hash = (Get-FileHash $dst -Algorithm SHA256).Hash.ToLower()
  Write-Output "$($s.file) $($c.Width)x$($c.Height) $((Get-Item $dst).Length) $hash"
  $c.Dispose()
}
$b.Dispose()
