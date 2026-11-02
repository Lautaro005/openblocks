# OpenBlocks installer for Windows.
#
#   irm https://raw.githubusercontent.com/Lautaro005/openblocks/main/install.ps1 | iex
#
# Remove it (your vaults and ~\.openblocks stay):
#   $env:OPENBLOCKS_UNINSTALL = "1"; irm https://raw.githubusercontent.com/Lautaro005/openblocks/main/install.ps1 | iex
param([switch]$Uninstall)
$ErrorActionPreference = "Stop"
$Repo = if ($env:OPENBLOCKS_REPO) { $env:OPENBLOCKS_REPO } else { "Lautaro005/openblocks" }
$BinDir = Join-Path $HOME ".local\bin"
$Dirs = @("$env:LOCALAPPDATA\OpenBlocks", "$env:LOCALAPPDATA\Programs\OpenBlocks")

function Say($m) { Write-Host "▸ $m" -ForegroundColor DarkYellow }
function Ok($m) { Write-Host "✓ $m" -ForegroundColor DarkGreen }

if ($Uninstall -or $env:OPENBLOCKS_UNINSTALL -eq "1") {
  Get-Process openblocks -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  $un = Get-ChildItem $Dirs -Filter "uninstall.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($un) { Start-Process $un.FullName -ArgumentList "/S" -Wait }
  Remove-Item (Join-Path $BinDir "openblocks.cmd") -ErrorAction SilentlyContinue
  Ok "Removed OpenBlocks. Your vaults were not touched; settings stay in $HOME\.openblocks"
  return
}

Write-Host ""
Write-Host "  OpenBlocks — block notes, in your own folder" -ForegroundColor White
Write-Host ""
Say "Looking up the latest release"
$rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "Accept" = "application/vnd.github+json"; "User-Agent" = "openblocks-installer" }
$asset = $rel.assets | Where-Object { $_.name -match "x64-setup\.exe$" } | Select-Object -First 1
if (-not $asset) { throw "Release $($rel.tag_name) has no Windows installer yet." }

$tmp = Join-Path $env:TEMP "openblocks-setup.exe"
Say "Downloading OpenBlocks $($rel.tag_name)"
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmp -UseBasicParsing
Get-Process openblocks -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Process $tmp -ArgumentList "/S" -Wait
Remove-Item $tmp -ErrorAction SilentlyContinue

$exe = Get-ChildItem $Dirs -Filter "openblocks.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$shim = Join-Path $BinDir "openblocks.cmd"
if ($exe) {
  Set-Content -Path $shim -Encoding ASCII -Value @"
@echo off
if "%~1"=="" (start "" "$($exe.FullName)" & exit /b)
"$($exe.FullName)" %*
"@
}
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$BinDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$BinDir;$userPath", "User")
  Say "Added $BinDir to your PATH (open a new terminal to use 'openblocks')"
}
Ok "Installed OpenBlocks $($rel.tag_name). Find it in the Start menu or run: openblocks"
if ($exe -and -not $env:OPENBLOCKS_NO_OPEN) { Start-Process $exe.FullName }
