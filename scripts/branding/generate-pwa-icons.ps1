$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$sourcePath = Join-Path $repoRoot 'assets\branding\chem-immuno-cbh-approved-master.png'
$publicPath = Join-Path $repoRoot 'public'
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw "Approved icon source not found: $sourcePath" }

$source = [System.Drawing.Image]::FromFile($sourcePath)
try {
  if ($source.Width -ne $source.Height) { throw 'Approved icon source must be square.' }

  function New-IconPng([int]$Size, [string]$Path, [double]$Scale = 1.0) {
    $canvas = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($canvas)
    try {
      $graphics.Clear([System.Drawing.Color]::White)
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $drawSize = [int][Math]::Round($Size * $Scale)
      $offset = [int][Math]::Floor(($Size - $drawSize) / 2)
      $destination = [System.Drawing.Rectangle]::new($offset, $offset, $drawSize, $drawSize)
      $graphics.DrawImage($source, $destination)
      $canvas.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $graphics.Dispose()
      $canvas.Dispose()
    }
  }

  New-IconPng 180 (Join-Path $publicPath 'apple-touch-icon.png')
  New-IconPng 192 (Join-Path $publicPath 'icon-192.png')
  New-IconPng 512 (Join-Path $publicPath 'icon-512.png')
  New-IconPng 512 (Join-Path $publicPath 'icon-maskable-512.png') 0.8
  New-IconPng 64 (Join-Path $publicPath 'favicon-64.png')

  $frames = foreach ($size in @(16, 32, 48, 64)) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $memory = [System.IO.MemoryStream]::new()
    try {
      $graphics.Clear([System.Drawing.Color]::White)
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $graphics.DrawImage($source, [System.Drawing.Rectangle]::new(0, 0, $size, $size))
      $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
      [pscustomobject]@{ Size = $size; Bytes = $memory.ToArray() }
    } finally {
      $memory.Dispose()
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  }

  $faviconPath = Join-Path $publicPath 'favicon.ico'
  $file = [System.IO.File]::Open($faviconPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  $writer = [System.IO.BinaryWriter]::new($file)
  try {
    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]$frames.Count)
    $offset = 6 + (16 * $frames.Count)
    foreach ($frame in $frames) {
      $writer.Write([byte]$frame.Size)
      $writer.Write([byte]$frame.Size)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([UInt16]1)
      $writer.Write([UInt16]32)
      $writer.Write([UInt32]$frame.Bytes.Length)
      $writer.Write([UInt32]$offset)
      $offset += $frame.Bytes.Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame.Bytes) }
  } finally {
    $writer.Dispose()
    $file.Dispose()
  }
} finally {
  $source.Dispose()
}

Write-Output 'Generated approved CHEM-IMMUNO CBH PNG and ICO sizes: 16, 32, 48, 64, 180, 192, 512; maskable art is inset to 80%.'
