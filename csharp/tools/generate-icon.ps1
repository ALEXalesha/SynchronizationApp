# Значок SyncGlass (.ico) в нескольких размерах - как tools/generate-icon.ps1 у Paint Pro.
# Цвет - акцент окна (#5B7FA6, логотип в шапке); две полупрозрачные «стеклянные» панели
# - две стороны синхронизации - и стрелка между ними.
# Запуск: powershell -ExecutionPolicy Bypass -File csharp/tools/generate-icon.ps1
Add-Type -AssemblyName System.Drawing

$sizes = @(256, 128, 64, 48, 32, 16)
$outIco = Join-Path $PSScriptRoot '..\src\SyncGlass.Wpf\Assets\AppIcon.ico'
New-Item -ItemType Directory -Force -Path (Split-Path $outIco) | Out-Null

function RoundRect($x, $y, $w, $h, $r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc($x, $y, $r*2, $r*2, 180, 90)
    $p.AddArc($x + $w - $r*2, $y, $r*2, $r*2, 270, 90)
    $p.AddArc($x + $w - $r*2, $y + $h - $r*2, $r*2, $r*2, 0, 90)
    $p.AddArc($x, $y + $h - $r*2, $r*2, $r*2, 90, 90)
    $p.CloseAllFigures()
    return $p
}

$pngs = @()
foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    # Фон: скруглённый квадрат цвета акцента, чуть темнее книзу.
    $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(0x6B,0x8F,0xB6)), ([System.Drawing.Color]::FromArgb(0x3E,0x5E,0x80)), 90.0
    $g.FillPath($bg, (RoundRect 0 0 $size $size ([Math]::Max(2, [int]($size * 0.22)))))

    # Две стеклянные панели - стороны синхронизации.
    $pane = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0x70, 0xFF, 0xFF, 0xFF))
    $edge = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(0xC0, 0xFF, 0xFF, 0xFF)), ([single][Math]::Max(1, $size * 0.02))
    $pw = $size * 0.26; $ph = $size * 0.50; $py = $size * 0.25; $pr = [Math]::Max(1, $size * 0.05)
    foreach ($px in @(($size * 0.14), ($size * 0.60))) {
        $p = RoundRect $px $py $pw $ph $pr
        $g.FillPath($pane, $p)
        if ($size -ge 32) { $g.DrawPath($edge, $p) }
    }

    # Стрелка слева направо между панелями.
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([single][Math]::Max(1.5, $size * 0.07))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $cy = $size * 0.50
    $g.DrawLine($pen, [single]($size * 0.36), [single]$cy, [single]($size * 0.62), [single]$cy)
    $g.DrawLines($pen, [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF ([single]($size * 0.53)), ([single]($cy - $size * 0.09))),
        (New-Object System.Drawing.PointF ([single]($size * 0.63)), ([single]$cy)),
        (New-Object System.Drawing.PointF ([single]($size * 0.53)), ([single]($cy + $size * 0.09)))))

    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs += ,@($size, $ms.ToArray())
    $bmp.Dispose()
}

# PNG внутри ICO (Windows Vista и новее).
$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $out
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$pngs.Count)
$dataOffset = 6 + 16 * $pngs.Count
foreach ($p in $pngs) {
    $s = $p[0]; $data = $p[1]
    $iconSize = if ($s -ge 256) { 0 } else { $s }
    $bw.Write([byte]$iconSize); $bw.Write([byte]$iconSize)
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$data.Length); $bw.Write([uint32]$dataOffset)
    $dataOffset += $data.Length
}
foreach ($p in $pngs) { $bw.Write($p[1]) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($outIco, $out.ToArray())
Write-Host "Wrote $outIco ($($out.Length) bytes, $($pngs.Count) sizes)"
