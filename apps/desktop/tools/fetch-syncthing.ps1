# Downloads the pinned Syncthing release (the file-synchronisation engine Solo drives) into resources/syncthing.
# The binary is MPL-2.0 licensed and is shipped unmodified; it is not committed to git. Run once after cloning.
#
# The SHA-256 below was checked against the checksum list published with the release on GitHub (over TLS). The
# release's PGP signature on that list was NOT verified when this was pinned (the signing key could not be fetched);
# verify it yourself when bumping the version: https://syncthing.net/security/
$ErrorActionPreference = "Stop"
$version = "v2.1.7"
$sha256 = "3ce7da770f546a8d02b65b2e7ee31f2a3b8b7c3f990ede045590cca4172ecfe1"
$dest = Join-Path $PSScriptRoot "..\resources\syncthing"
if (Test-Path (Join-Path $dest "syncthing.exe")) { Write-Host "Syncthing already present: $dest"; exit 0 }

$zip = Join-Path $env:TEMP "syncthing-windows-amd64-$version.zip"
Invoke-WebRequest "https://github.com/syncthing/syncthing/releases/download/$version/syncthing-windows-amd64-$version.zip" -OutFile $zip
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $sha256) { Remove-Item $zip -Force; throw "Checksum mismatch for Syncthing $version (got $actual). Refusing to install." }

$tmp = Join-Path $env:TEMP "syncthing-extract"
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive $zip $tmp
New-Item -ItemType Directory -Force $dest | Out-Null
$root = Join-Path $tmp "syncthing-windows-amd64-$version"
foreach ($f in "syncthing.exe", "LICENSE.txt", "AUTHORS.txt", "README.txt") { Copy-Item (Join-Path $root $f) $dest -Force }
Write-Host "Syncthing $version installed in $dest"
