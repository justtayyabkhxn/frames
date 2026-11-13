# First run of frames.cmd on a PC without Frames' portable Node.js: show the banner, fetch Node 24 LTS
# into tools\node (live progress, checksum-verified). Everything else is installed by standalone\install.mjs.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$tools = Join-Path $root 'tools'

$colors = 'Cyan', 'Cyan', 'Blue', 'Magenta', 'Magenta'
$i = 0
Write-Host ''
Get-Content (Join-Path $PSScriptRoot 'banner.txt') | ForEach-Object { Write-Host "  $_" -ForegroundColor $colors[[Math]::Min($i++, 4)] }
Write-Host ''
Write-Host '  Photos  -  People  -  Places' -ForegroundColor Green
Write-Host '  your whole library, offline on this PC' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  First-time setup. ' -NoNewline
Write-Host 'Everything is kept inside this Frames folder.' -ForegroundColor DarkGray
Write-Host ''
Write-Host ' == [0] Node.js runtime ==' -ForegroundColor Magenta

New-Item -ItemType Directory -Force $tools | Out-Null
# The newest Node 24 (LTS) and its checksum, from one small file
$sums = curl.exe -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
if ($LASTEXITCODE) { throw 'Could not reach nodejs.org. Check your internet connection.' }
$line = $sums | Where-Object { $_ -match '  (node-(v24[.0-9]+)-win-x64[.]zip)$' } | Select-Object -First 1
$null = $line -match '^(\w+)  (node-(v24[.0-9]+)-win-x64[.]zip)$'
$expected, $zip, $v = $Matches[1], $Matches[2], $Matches[3]
$file = Join-Path $tools $zip
Write-Host "   Downloading Node.js $v" -ForegroundColor DarkGray
curl.exe -fL --progress-bar -o $file "https://nodejs.org/dist/$v/$zip"
if ($LASTEXITCODE) { throw 'Node.js download failed.' }
if ((Get-FileHash $file -Algorithm SHA256).Hash -ne $expected.ToUpper()) {
  Remove-Item $file
  throw 'Node.js download is corrupt (checksum mismatch). Try again.'
}
# Windows' own tar (Git's tar, if first on PATH, can't read drive letters)
& "$env:SystemRoot\System32\tar.exe" -xf $file -C $tools
if ($LASTEXITCODE) { throw 'Could not unpack Node.js.' }
Remove-Item $file
Rename-Item (Join-Path $tools "node-$v-win-x64") 'node'
Write-Host "   OK Node.js $v ready" -ForegroundColor Green
