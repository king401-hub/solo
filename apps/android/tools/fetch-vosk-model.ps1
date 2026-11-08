# Downloads the offline models the phone app needs into the Android assets (not committed to git). Run once after
# cloning, before building the APK:
#   1. Vosk English model (about 41 MB zipped): on-phone wake-word listening and speech recognition.
#   2. WavLM speaker model (about 100 MB): recognising the owner's voice, the same model the desktop uses.
$ErrorActionPreference = "Stop"
$assets = Join-Path $PSScriptRoot "..\android\app\src\main\assets"
$dest = Join-Path $assets "model-en-us"

if (Test-Path (Join-Path $dest "uuid")) {
  Write-Host "Vosk model already present: $dest"
} else {
  $zip = Join-Path $env:TEMP "vosk-model-small-en-us-0.15.zip"
  Invoke-WebRequest "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip" -OutFile $zip
  $tmp = Join-Path $env:TEMP "vosk-model-extract"
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive $zip $tmp
  New-Item -ItemType Directory -Force $assets | Out-Null
  if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
  Move-Item (Join-Path $tmp "vosk-model-small-en-us-0.15") $dest
  # StorageService.unpack needs a uuid file to know when the unpacked copy is stale.
  [guid]::NewGuid().ToString() | Set-Content -NoNewline (Join-Path $dest "uuid")
  Write-Host "Vosk model installed in $dest"
}

$spk = Join-Path $assets "wavlm-sv\model_quantized.onnx"
if (Test-Path $spk) {
  Write-Host "Speaker model already present: $spk"
} else {
  New-Item -ItemType Directory -Force (Split-Path $spk) | Out-Null
  Invoke-WebRequest "https://huggingface.co/Xenova/wavlm-base-plus-sv/resolve/main/onnx/model_quantized.onnx" -OutFile $spk
  Write-Host "Speaker model installed in $spk"
}
