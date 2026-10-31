# windows-ocr.ps1 -- local OCR through the Windows built-in engine (Windows.Media.Ocr).
#
# Contract (this file is intentionally ASCII-only: Windows PowerShell 5.1 reads a
# script without a BOM using the ANSI code page, so any non-ASCII byte in code or
# comments can corrupt parsing):
#
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#     -File windows-ocr.ps1 -RequestPath <request.json> -ResultPath <result.json>
#
#   request.json : { "imagePath": "D:\\a.png", "language": "" | "zh-Hans" | "en-US",
#                    "scale": 0 }
#                  language "" / "auto" = pick per content (see below)
#                  scale 0 / missing = auto (upscale small text for a second pass)
#
#   result.json  : { ok, engine, language, languagePicked, availableLanguages,
#                    width, height, scale, text, lines[], words[{t,x,y,w,h}],
#                    charCount, lineCount, wordCount, coverage, upscaledFrom,
#                    passes[], elapsedMs, error{code,message}|null }
#
# Two accuracy tricks, both measured on real screenshots:
#   1. small text (median glyph height < 16 px) is re-recognised on a 2-3x
#      BitmapTransform bitmap -- 14 px code goes from ~0.73 to ~0.87 similarity;
#   2. a mostly-ASCII image is recognised twice (zh engine then en engine): the
#      Chinese model mangles ASCII identifiers ("Fi1e", "a11"), the English one does not.
#
# Every failure is reported as ok=false + error.code (never a stack trace), except a
# missing WinRT bridge, which exits 2.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $RequestPath,
  [Parameter(Mandatory = $true)][string] $ResultPath
)

$ErrorActionPreference = 'Stop'

# A median word height below this (px) means "small text"; a second, upscaled pass helps.
$smallTextPx = 16
$targetTextPx = 32
$maxScale = 3
# Below this share of CJK characters the image is treated as ASCII-first and re-tried
# with the English recognizer.
$cjkThreshold = 0.15

$result = [ordered]@{
  ok                 = $false
  engine             = 'Windows.Media.Ocr'
  language           = $null
  languagePicked     = 'manual'
  availableLanguages = @()
  width              = 0
  height             = 0
  scale              = 1
  text               = ''
  lines              = @()
  words              = @()
  wordsTruncated     = $false
  charCount          = 0
  lineCount          = 0
  wordCount          = 0
  coverage           = 0.0
  upscaledFrom       = 0
  nativeWidth        = 0
  nativeHeight       = 0
  maxImageDimension  = 0
  passes             = @()
  elapsedMs          = 0
  error              = $null
}

$script:errorCode = 'OCR_FAILED'
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

function Fail([string] $code, [string] $message) {
  $script:errorCode = $code
  throw $message
}

function Write-Result {
  $json = $result | ConvertTo-Json -Depth 8 -Compress
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($ResultPath, $json, $utf8)
}

# --- WinRT plumbing -----------------------------------------------------------------
function Initialize-WinRt {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapInterpolationMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.ExifOrientationMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.ColorManagementMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
}

$script:asTaskGeneric = $null

function Get-AsTaskGeneric {
  if ($script:asTaskGeneric -ne $null) { return $script:asTaskGeneric }
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and
    $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  if ($method -eq $null) { Fail 'WINRT_BRIDGE' 'cannot find System.WindowsRuntimeSystemExtensions.AsTask(IAsyncOperation<T>)' }
  $script:asTaskGeneric = $method
  return $method
}

function Await($operation, [Type] $resultType) {
  $asTask = (Get-AsTaskGeneric).MakeGenericMethod($resultType)
  $task = $asTask.Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

function Pick-Language([string] $preferred) {
  $available = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)
  if ($available.Count -eq 0) { return $null }
  if (-not [string]::IsNullOrWhiteSpace($preferred)) {
    $wanted = $preferred.Trim()
    $exact = $available | Where-Object { $_.LanguageTag -eq $wanted } | Select-Object -First 1
    if ($exact -ne $null) { return $exact }
    $primary = $wanted.Split('-')[0]
    $prefix = $available | Where-Object { $_.LanguageTag -eq $primary -or $_.LanguageTag.StartsWith($primary + '-') } | Select-Object -First 1
    if ($prefix -ne $null) { return $prefix }
  }
  return $null
}

function Get-MedianHeight($words) {
  $heights = @($words | ForEach-Object { [int] $_.h } | Where-Object { $_ -gt 2 } | Sort-Object)
  if ($heights.Count -eq 0) { return 0 }
  return [int] $heights[[int][Math]::Floor($heights.Count / 2)]
}

function Get-CjkCount([string] $text) {
  if ([string]::IsNullOrEmpty($text)) { return 0 }
  return ([regex]::Matches($text, '[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]')).Count
}

# One OCR pass on the decoder at a given integer scale.
function Invoke-OcrPass($decoder, $engine, [int] $scale) {
  if ($scale -le 1) {
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  }
  else {
    $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
    $transform.ScaledWidth = [uint32]([double] $decoder.PixelWidth * $scale)
    $transform.ScaledHeight = [uint32]([double] $decoder.PixelHeight * $scale)
    $transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
        $transform,
        [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
        [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  }

  $ocr = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

  $words = @()
  $lines = @()
  $parts = New-Object System.Collections.Generic.List[string]
  $areaSum = 0.0
  $truncated = $false
  foreach ($line in $ocr.Lines) {
    $lineWords = @($line.Words)
    foreach ($word in $lineWords) {
      $rect = $word.BoundingRect
      $areaSum += ([double] $rect.Width) * ([double] $rect.Height)
      if ($words.Count -lt 6000) {
        $words += [ordered]@{
          t = [string] $word.Text
          x = [int] $rect.X
          y = [int] $rect.Y
          w = [int] $rect.Width
          h = [int] $rect.Height
        }
      }
      else {
        $truncated = $true
      }
    }
    if (-not [string]::IsNullOrWhiteSpace($line.Text)) {
      $parts.Add($line.Text)
      $first = $lineWords[0]
      $rect = if ($first -ne $null) { $first.BoundingRect } else { $null }
      $lines += [ordered]@{
        text = $line.Text
        x    = if ($rect -ne $null) { [int] $rect.X } else { 0 }
        y    = if ($rect -ne $null) { [int] $rect.Y } else { 0 }
        w    = if ($rect -ne $null) { [int] $rect.Width } else { 0 }
        h    = if ($rect -ne $null) { [int] $rect.Height } else { 0 }
      }
    }
  }

  $text = $parts -join "`n"
  $scaledWidth = [int] ([double] $decoder.PixelWidth * $scale)
  $scaledHeight = [int] ([double] $decoder.PixelHeight * $scale)
  $totalArea = ([double] $scaledWidth) * ([double] $scaledHeight)
  $coverage = 0.0
  if ($totalArea -gt 0) { $coverage = [Math]::Round([Math]::Min(1.0, $areaSum / $totalArea), 4) }

  return @{
    words        = $words
    lines        = $lines
    text         = $text
    width        = $scaledWidth
    height       = $scaledHeight
    scale        = $scale
    charCount    = $text.Length
    coverage     = $coverage
    truncated    = $truncated
    medianHeight = (Get-MedianHeight $words)
  }
}

# Pass 1 at native size, then (only for small text) one upscaled pass. Picks the
# upscaled result unless it lost more than 30% of the characters.
function Get-BestPass($decoder, $engine, [int] $longSide, $passLog) {
  $first = Invoke-OcrPass $decoder $engine 1
  $passLog.Add([ordered]@{ scale = 1; width = $first.width; height = $first.height; chars = $first.charCount; medianHeight = $first.medianHeight })
  $selected = $first
  if ($first.medianHeight -gt 0 -and $first.medianHeight -lt $smallTextPx) {
    $factor = [int] [Math]::Ceiling($targetTextPx / $first.medianHeight)
    if ($factor -lt 2) { $factor = 2 }
    if ($factor -gt $maxScale) { $factor = $maxScale }
    if ($longSide * $factor -le [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) {
      $second = Invoke-OcrPass $decoder $engine $factor
      $passLog.Add([ordered]@{ scale = $factor; width = $second.width; height = $second.height; chars = $second.charCount; medianHeight = $second.medianHeight })
      if ($second.charCount -ge [int]($first.charCount * 0.7)) { $selected = $second }
    }
  }
  return $selected
}

try {
  Initialize-WinRt

  $request = [System.IO.File]::ReadAllText($RequestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  $imagePath = [string] $request.imagePath
  if ([string]::IsNullOrWhiteSpace($imagePath)) { Fail 'BAD_REQUEST' 'imagePath is empty' }
  if (-not [System.IO.File]::Exists($imagePath)) { Fail 'FILE_NOT_FOUND' ('file not found: ' + $imagePath) }

  $result.availableLanguages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
  $result.maxImageDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  if ($result.availableLanguages.Count -eq 0) { Fail 'NO_OCR_ENGINE' 'no OCR recognizer language is installed on this Windows' }

  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imagePath)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  }
  catch {
    Fail 'DECODE_FAILED' ('cannot decode image (the format may need a codec this Windows does not have): ' + $_.Exception.Message)
  }

  $result.nativeWidth = [int] $decoder.PixelWidth
  $result.nativeHeight = [int] $decoder.PixelHeight
  $longSide = [Math]::Max($result.nativeWidth, $result.nativeHeight)
  if ($longSide -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) {
    Fail 'IMAGE_TOO_LARGE' ('image is ' + $result.nativeWidth + 'x' + $result.nativeHeight +
      '; the Windows OCR engine accepts at most ' + [Windows.Media.Ocr.OcrEngine]::MaxImageDimension +
      ' px on the long side. Downscale it first (for example with ImageMagick or a screenshot tool).')
  }

  $passLog = New-Object System.Collections.Generic.List[object]
  $requested = [string] $request.language
  $auto = [string]::IsNullOrWhiteSpace($requested) -or $requested.Trim().ToLowerInvariant() -eq 'auto'

  $selected = $null
  if ($auto) {
    # Writing systems are a property of the screenshot, not of the caller: run the
    # Chinese model first (it handles CJK UI), and if the result is mostly ASCII run the
    # English model too -- the Chinese recognizer turns ASCII identifiers into lookalikes.
    $zhLanguage = Pick-Language 'zh'
    $enLanguage = Pick-Language 'en'
    $zhEngine = $null
    if ($zhLanguage -ne $null) { $zhEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($zhLanguage) }
    if ($zhEngine -eq $null) { $zhEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
    if ($zhEngine -eq $null -and $enLanguage -ne $null) { $zhEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($enLanguage) }
    if ($zhEngine -eq $null) { Fail 'NO_OCR_ENGINE' 'cannot create an OCR engine for any installed language' }

    $selected = Get-BestPass $decoder $zhEngine $longSide $passLog
    $result.language = $zhEngine.RecognizerLanguage.LanguageTag
    $result.languagePicked = 'zh-first'
    $cjk = Get-CjkCount $selected.text
    $cjkShare = 0.0
    if ($selected.charCount -gt 0) { $cjkShare = $cjk / $selected.charCount }
    if ($cjkShare -lt $cjkThreshold -and $enLanguage -ne $null) {
      $enEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($enLanguage)
      if ($enEngine -ne $null) {
        $enPass = Get-BestPass $decoder $enEngine $longSide $passLog
        # The English model is the better reader for ASCII, but a mixed screenshot can
        # lose its CJK sentences there; only take it when it kept a plausible amount of text.
        if ($enPass.charCount -ge [int]($selected.charCount * 0.6)) {
          $selected = $enPass
          $result.language = $enEngine.RecognizerLanguage.LanguageTag
          $result.languagePicked = 'ascii-picked-en'
        }
        else {
          $result.languagePicked = 'ascii-kept-zh'
        }
      }
    }
  }
  else {
    $language = Pick-Language $requested
    if ($language -eq $null) { Fail 'NO_OCR_ENGINE' ('requested OCR language is not installed: ' + $requested +
        '; installed: ' + ($result.availableLanguages -join ', ')) }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    if ($engine -eq $null) { Fail 'NO_OCR_ENGINE' ('cannot create an OCR engine for ' + $language.LanguageTag) }
    $selected = Get-BestPass $decoder $engine $longSide $passLog
    $result.language = $engine.RecognizerLanguage.LanguageTag
    $result.languagePicked = 'manual'
  }

  $result.ok = $true
  $result.width = $selected.width
  $result.height = $selected.height
  $result.scale = $selected.scale
  $result.upscaledFrom = if ($selected.scale -gt 1) { 1 } else { 0 }
  $result.text = $selected.text
  $result.lines = $selected.lines
  $result.words = $selected.words
  $result.wordsTruncated = $selected.truncated
  $result.charCount = $selected.charCount
  $result.lineCount = $selected.lines.Count
  $result.wordCount = $selected.words.Count
  $result.coverage = $selected.coverage
  $result.passes = $passLog
}
catch {
  $result.ok = $false
  $result.error = [ordered]@{
    code    = $script:errorCode
    message = $_.Exception.Message
  }
}
finally {
  $result.elapsedMs = [int] $stopwatch.ElapsedMilliseconds
  Write-Result
}

if ($result.ok -ne $true -and $script:errorCode -eq 'WINRT_BRIDGE') { exit 2 }
exit 0
