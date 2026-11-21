# VisioDental Server - desinstallation (Windows, PowerShell 5.1+).
#
#   powershell -ExecutionPolicy Bypass -File uninstall-server.ps1
#   ... -KeepData        conserve .env, data\, backups\ et logs\
#   ... -RemoveDatabase  supprime aussi le cluster PostgreSQL (donnees patients)
#
# Sans -RemoveDatabase : services et fichiers du programme supprimes ;
# donnees CONSERVEES dans <InstallDir> (data, backups, logs, .env), ce qui
# permet de reinstaller une version neuve sans perdre les patients.

param(
  [string]$InstallDir = "C:\Program Files\VisioDental",
  [switch]$KeepData,
  [switch]$RemoveDatabase
)

$ErrorActionPreference = "Stop"
$AppService = "VisioDental"
$PgService = "VisioDentalPostgres"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Ce script doit etre lance en administrateur."
  }
}

function Stop-And-RemoveService([string]$Name, [string]$ExePath) {
  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $service) { return }
  if ($service.Status -ne "Stopped") {
    Stop-Service -Name $Name -Force
    (Get-Service -Name $Name).WaitForStatus("Stopped", (New-TimeSpan -Seconds 60))
  }
  if (Test-Path $ExePath) {
    & $ExePath uninstall
    Start-Sleep -Seconds 1
  }
  if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
    & sc.exe delete $Name | Out-Null
  }
  Write-Host "    Service $Name supprime." -ForegroundColor Green
}

Assert-Admin
Write-Step "Arret et suppression des services"
Stop-And-RemoveService $AppService (Join-Path $InstallDir "$AppService.exe")
Stop-And-RemoveService $PgService (Join-Path $InstallDir "$PgService.exe")

Write-Step "Pare-feu et tache planifiee"
Remove-NetFirewallRule -DisplayName "VisioDental (site)" -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "VisioDental Backup" -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "    Nettoyage termine." -ForegroundColor Green

if ($RemoveDatabase -and -not $KeepData) {
  Write-Step "Suppression des donnees (base comprise)"
  if (Test-Path (Join-Path $InstallDir "data\pg")) {
    Remove-Item (Join-Path $InstallDir "data") -Recurse -Force
    Write-Host "    Cluster PostgreSQL supprime." -ForegroundColor Yellow
  }
}

if ($KeepData) {
  Write-Step "Fichiers du programme seuls"
}
if ($KeepData -or (-not $RemoveDatabase)) {
  if (-not $KeepData) { Write-Step "Suppression des fichiers du programme" }
  foreach ($folder in @("api", "site", "runtime", "pgsql")) {
    $path = Join-Path $InstallDir $folder
    if (Test-Path $path) { Remove-Item $path -Recurse -Force }
  }
  foreach ($file in @("$AppService.exe", "$PgService.exe", "$AppService.xml", "$PgService.xml", "VERSION", "server.env.example")) {
    $path = Join-Path $InstallDir $file
    if (Test-Path $path) { Remove-Item $path -Force }
  }
  Write-Host "    Donnees conservees dans $InstallDir (data, backups, logs, .env)." -ForegroundColor Yellow
}
elseif ($RemoveDatabase) {
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  Write-Host "    $InstallDir supprime." -ForegroundColor Green
}

Write-Host ""
Write-Host "Desinstallation terminee." -ForegroundColor Green
