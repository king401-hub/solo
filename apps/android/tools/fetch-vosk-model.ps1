# Downloads the offline Vosk English model used for on-phone wake-word listening into the Android assets.
# The model (about 41 MB zipped) is not committed to git. Run once after cloning, before building the APK.
$ErrorActionPreference = "Stop"
$assets = Join-Path $PSScriptRoot "..\android\app\src\main\assets"
$dest = Join-Path $assets "model-en-us"
if (Test-Path (Join-Path $dest "uuid")) { Write-Host "Model already present: $dest"; exit 0 }
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
Write-Host "Model installed in $dest"
