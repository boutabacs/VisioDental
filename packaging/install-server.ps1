# VisioDental Server - installateur (Windows, PowerShell 5.1+).
#
# A executer en administrateur depuis le dossier du paquet dist-server :
#
#   powershell -ExecutionPolicy Bypass -File install-server.ps1
#
# Options utiles :
#   -InstallDir "D:\VisioDental"   dossier cible (defaut : Program Files)
#   -SitePort 3000                 port du site (pare-feu)
#   -PostgresPort 5432             port PostgreSQL local (auto si occupe)
#   -SkipPostgres -ExistingDatabaseUrl "postgresql://..."  base deja hebergee
#   -NoLaunch                      ne pas ouvrir le navigateur a la fin
#
# Le script est rejouable : une mise a jour conserve .env, data\, backups\ et
# rejoue schema + donnees structurelles.

param(
  [string]$InstallDir = "C:\Program Files\VisioDental",
  [int]$SitePort = 3000,
  [int]$ApiPort = 8100,
  [int]$PostgresPort = 5432,
  [string]$DatabaseName = "visiodental",
  [string]$DatabaseUser = "visiodental",
  [string]$PostgresZipUrl = "https://get.enterprisedb.com/postgresql/postgresql-16.9-1-windows-x64-binaries.zip",
  [string]$WinSWUrl = "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET4.exe",
  [switch]$SkipPostgres,
  [string]$ExistingDatabaseUrl = "",
  [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
$AppService = "VisioDental"
$PgService = "VisioDentalPostgres"
$SourceDir = $PSScriptRoot

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
  Write-Host "    $Message" -ForegroundColor Green
}

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Ce script doit etre lance en administrateur (clic droit > Executer en tant qu'administrateur)."
  }
}

function New-RandomText([int]$Length) {
  $alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  $bytes = New-Object byte[] $Length
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
}

function New-HexSecret([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  ($buffer | ForEach-Object { $_.ToString("x2") }) -join ""
}

function Test-TcpPort([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(500)) { return $false }
    $client.EndConnect($async)
    return $true
  }
  catch {
    return $false
  }
  finally {
    $client.Close()
  }
}

function Wait-TcpPort([int]$Port, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-TcpPort $Port) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Stop-ServiceIfExists([string]$Name) {
  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($service) {
    if ($service.Status -ne "Stopped") {
      Stop-Service -Name $Name -Force
      (Get-Service -Name $Name).WaitForStatus("Stopped", (New-TimeSpan -Seconds 60))
    }
  }
}

function Get-WinSW([string]$TargetExe) {
  $bundled = Join-Path $SourceDir "runtime\winsw.exe"
  if (Test-Path $bundled) {
    Copy-Item $bundled $TargetExe -Force
    return
  }
  if (Test-Path $TargetExe) { return }
  Write-Host "    Telechargement de WinSW..."
  $temp = Join-Path $env:TEMP "visiodental-winsw.exe"
  Invoke-WebRequest -Uri $WinSWUrl -OutFile $temp -UseBasicParsing
  Copy-Item $temp $TargetExe -Force
  Remove-Item $temp -Force
}

# ---------------------------------------------------------------------------

Assert-Admin

if (-not (Test-Path (Join-Path $SourceDir "api\dist\server.js"))) {
  throw "Paquet incomplet : api\dist\server.js introuvable. Lancez le script depuis dist-server."
}
if (-not (Test-Path (Join-Path $SourceDir "site\.output\server\index.mjs"))) {
  throw "Paquet incomplet : site\.output introuvable."
}

Write-Step "Preparation de $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
foreach ($sub in @("data", "data\pg", "data\storage", "backups", "logs")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir $sub) | Out-Null
}

Write-Step "Arret des services existants (mise a jour)"
Stop-ServiceIfExists $AppService

$inPlace = ([IO.Path]::GetFullPath($SourceDir).TrimEnd("\") -eq [IO.Path]::GetFullPath($InstallDir).TrimEnd("\"))
if ($inPlace) {
  Write-Ok "Installation en place : copie ignoree."
}
else {
  foreach ($folder in @("api", "site", "runtime")) {
    $result = robocopy (Join-Path $SourceDir $folder) (Join-Path $InstallDir $folder) /MIR /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { throw "Echec de la copie de $folder (robocopy $LASTEXITCODE)" }
  }
  Copy-Item (Join-Path $SourceDir "VERSION") $InstallDir -Force
  Copy-Item (Join-Path $SourceDir "server.env.example") $InstallDir -Force
  Copy-Item (Join-Path $SourceDir "VisioDental.xml") $InstallDir -Force
  Copy-Item (Join-Path $SourceDir "VisioDentalPostgres.xml") $InstallDir -Force
  Write-Ok "Fichiers copies."
}

# --- configuration ---------------------------------------------------------

$envFile = Join-Path $InstallDir ".env"
$dbPassword = $null
$databaseUrl = $null

if (Test-Path $envFile) {
  Write-Step "Configuration existante conservee (.env)"
  $urlLine = Get-Content $envFile | Where-Object { $_ -match "^DATABASE_URL=" } | Select-Object -First 1
  $databaseUrl = $urlLine.Substring("DATABASE_URL=".Length)
  $match = [regex]::Match($databaseUrl, '://[^:]+:(?<password>[^@]*)@')
  if ($match.Success) { $dbPassword = $match.Groups["password"].Value }
}
else {
  Write-Step "Generation de la configuration (.env)"
  if ($ExistingDatabaseUrl) {
    $databaseUrl = $ExistingDatabaseUrl
  }
  else {
    $dbPassword = New-RandomText 24
    if ($PostgresPort -eq 5432 -and (Test-TcpPort $PostgresPort)) {
      $probe = 5433
      while ($probe -le 5442 -and (Test-TcpPort $probe)) { $probe++ }
      $PostgresPort = $probe
      Write-Ok "Port 5432 deja utilise : PostgreSQL VisioDental utilisera $PostgresPort."
    }
    $databaseUrl = "postgresql://${DatabaseUser}:${dbPassword}@127.0.0.1:${PostgresPort}/${DatabaseName}?schema=public"
  }

  $template = Get-Content (Join-Path $InstallDir "server.env.example") -Raw
  $template = $template.Replace("CHANGE_ME_DB_PASSWORD", [string]$dbPassword)
  $template = $template.Replace("CHANGE_ME_SECRET_KEY", (New-HexSecret 32))
  $template = $template.Replace("postgresql://visiodental:CHANGE_ME_DB_PASSWORD@127.0.0.1:5432/visiodental", $databaseUrl)
  $template = [regex]::Replace($template, "(?m)^PORT=\d+", "PORT=$ApiPort")
  $template = [regex]::Replace($template, "(?m)^NUXT_PORT=\d+", "NUXT_PORT=$SitePort")
  $template = [regex]::Replace($template, "(?m)^DATABASE_URL=.*$", "DATABASE_URL=$databaseUrl")
  Set-Content -Path $envFile -Value $template -Encoding ASCII
  Write-Ok ".env ecrit."
}

# Variables de l'installation courante (mise a jour : relire .env).
$envContent = Get-Content $envFile
$databaseUrl = ($envContent | Where-Object { $_ -match "^DATABASE_URL=" } | Select-Object -First 1).Substring("DATABASE_URL=".Length)
$portLine = $envContent | Where-Object { $_ -match "^NUXT_PORT=" } | Select-Object -First 1
if ($portLine) { $SitePort = [int]$portLine.Substring("NUXT_PORT=".Length) }
$apiPortLine = $envContent | Where-Object { $_ -match "^PORT=" } | Select-Object -First 1
if ($apiPortLine) { $ApiPort = [int]$apiPortLine.Substring("PORT=".Length) }

# --- PostgreSQL ------------------------------------------------------------

$pgRoot = Join-Path $InstallDir "pgsql"
$pgData = Join-Path $InstallDir "data\pg"
$pgBin = Join-Path $pgRoot "bin"

if ($SkipPostgres) {
  Write-Step "PostgreSQL : base externe (fournie par DATABASE_URL)"
}
else {
  Write-Step "PostgreSQL embarque"
  if (-not (Test-Path (Join-Path $pgBin "postgres.exe"))) {
    $zip = Join-Path $env:TEMP "visiodental-postgres.zip"
    $localZip = Get-ChildItem (Join-Path $SourceDir "postgresql-*-windows-x64-binaries.zip") -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($localZip) {
      Write-Host "    PostgreSQL portable : archive locale $($localZip.Name)"
      Copy-Item $localZip.FullName $zip -Force
    }
    else {
      Write-Host "    Telechargement de PostgreSQL portable (environ 300 Mo)..."
      Invoke-WebRequest -Uri $PostgresZipUrl -OutFile $zip -UseBasicParsing
    }
    $extract = Join-Path $env:TEMP ("visiodental-pg-" + [Guid]::NewGuid().ToString("N"))
    Expand-Archive -Path $zip -DestinationPath $extract -Force
    $inner = Join-Path $extract "pgsql"
    if (-not (Test-Path $inner)) { throw "Archive PostgreSQL inattendue (dossier pgsql absent)." }
    if (Test-Path $pgRoot) { Remove-Item $pgRoot -Recurse -Force }
    Move-Item $inner $pgRoot
    Remove-Item $extract -Recurse -Force
    Remove-Item $zip -Force
    Write-Ok "PostgreSQL extrait dans $pgRoot."
  }

  if (-not (Test-Path (Join-Path $pgData "PG_VERSION"))) {
    Write-Host "    Initialisation du cluster..."
    & (Join-Path $pgBin "initdb.exe") -D $pgData -U postgres --auth-local=trust --auth-host=trust --encoding=UTF8 --locale=C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "initdb a echoue (code $LASTEXITCODE)" }
    & icacls $pgData /grant "NT AUTHORITY\SYSTEM:(OI)(CI)F" /T /Q | Out-Null
    Write-Ok "Cluster initialise."
  }

  $pgMatch = [regex]::Match($databaseUrl, '@127\.0\.0\.1:(?<port>\d+)/')
  $PostgresPort = if ($pgMatch.Success) { [int]$pgMatch.Groups["port"].Value } else { $PostgresPort }

  # Le service lance `postgres -D data\pg` : le port et l'interface d'ecoute
  # viennent donc de postgresql.conf. On force la boucle locale (seul l'API y
  # accede) et le port choisi par l'installateur.
  $pgConf = Join-Path $pgData "postgresql.conf"
  $conf = Get-Content $pgConf | Where-Object { $_ -notmatch '^\s*(port|listen_addresses)\s*=' }
  $conf += "port = $PostgresPort"
  $conf += "listen_addresses = '127.0.0.1'"
  Set-Content -Path $pgConf -Value $conf -Encoding ASCII

  Get-WinSW (Join-Path $InstallDir "$PgService.exe")
  $pgServiceExe = Join-Path $InstallDir "$PgService.exe"
  if (-not (Get-Service -Name $PgService -ErrorAction SilentlyContinue)) {
    & $pgServiceExe install
    Start-Sleep -Seconds 1
  }
  if ((Get-Service -Name $PgService).Status -ne "Running") {
    Start-Service -Name $PgService
  }
  if (-not (Wait-TcpPort $PostgresPort 60)) {
    throw "PostgreSQL n'ecoute pas sur le port $PostgresPort. Consultez $InstallDir\logs."
  }
  Write-Ok "PostgreSQL en ecoute sur 127.0.0.1:$PostgresPort."

  $psql = Join-Path $pgBin "psql.exe"
  $roleExists = & $psql -h 127.0.0.1 -p $PostgresPort -U postgres -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DatabaseUser'"
  if ($roleExists -ne "1") {
    & $psql -h 127.0.0.1 -p $PostgresPort -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE $DatabaseUser LOGIN PASSWORD '$dbPassword'"
    if ($LASTEXITCODE -ne 0) { throw "Creation du role $DatabaseUser impossible." }
    Write-Ok "Role $DatabaseUser cree."
  }
  $dbExists = & $psql -h 127.0.0.1 -p $PostgresPort -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DatabaseName'"
  if ($dbExists -ne "1") {
    & $psql -h 127.0.0.1 -p $PostgresPort -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DatabaseName OWNER $DatabaseUser ENCODING 'UTF8'"
    if ($LASTEXITCODE -ne 0) { throw "Creation de la base $DatabaseName impossible." }
    Write-Ok "Base $DatabaseName creee."
  }
}

# --- schema + donnees structurelles ---------------------------------------

$nodeExe = Join-Path $InstallDir "runtime\node.exe"
$apiDir = Join-Path $InstallDir "api"
Push-Location $apiDir
try {
  Write-Step "Synchronisation du schema (prisma db push)"
  $env:DATABASE_URL = $databaseUrl
  & $nodeExe (Join-Path $apiDir "node_modules\prisma\build\index.js") db push --skip-generate "--schema=$(Join-Path $apiDir 'prisma\schema.prisma')"
  if ($LASTEXITCODE -ne 0) { throw "prisma db push a echoue (code $LASTEXITCODE)" }

  Write-Step "Amorcage des donnees structurelles"
  & $nodeExe (Join-Path $apiDir "dist\scripts\provision.js")
  if ($LASTEXITCODE -ne 0) { throw "L'amorcage a echoue (code $LASTEXITCODE)" }
}
finally {
  Pop-Location
  Remove-Item Env:\DATABASE_URL -ErrorAction SilentlyContinue
}

# --- service applicatif ----------------------------------------------------

Write-Step "Service Windows $AppService"
Get-WinSW (Join-Path $InstallDir "$AppService.exe")
$appServiceExe = Join-Path $InstallDir "$AppService.exe"
if (-not (Get-Service -Name $AppService -ErrorAction SilentlyContinue)) {
  & $appServiceExe install
  Start-Sleep -Seconds 1
}
& sc.exe config $AppService "depend= $PgService" | Out-Null
if ((Get-Service -Name $AppService).Status -ne "Running") {
  Start-Service -Name $AppService
}
Write-Ok "Service demarre."

Write-Step "Pare-feu (port $SitePort, profil prive)"
Remove-NetFirewallRule -DisplayName "VisioDental (site)" -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "VisioDental (site)" -Direction Inbound -Protocol TCP -LocalPort $SitePort -Action Allow -Profile Private | Out-Null
Write-Ok "Regle ajoutee. L'API ($ApiPort) reste en boucle locale."

Write-Step "Sauvegarde quotidienne"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\runtime\backup.ps1`" -InstallDir `"$InstallDir`""
$trigger = New-ScheduledTaskTrigger -Daily -At 22:30
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName "VisioDental Backup" -Action $action -Trigger $trigger -Principal $principal -Description "Sauvegarde quotidienne de la base VisioDental" -Force | Out-Null
Write-Ok "Tache 'VisioDental Backup' planifiee a 22:30."

# --- fin -------------------------------------------------------------------

Wait-TcpPort $SitePort 60 | Out-Null
$lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.PrefixOrigin -ne "WellKnown" } |
  Select-Object -First 1 -ExpandProperty IPAddress)

Write-Host ""
Write-Host "Installation terminee." -ForegroundColor Green
Write-Host "  Poste serveur : http://localhost:$SitePort"
if ($lanIp) { Write-Host "  Reseau local  : http://${lanIp}:$SitePort" }
Write-Host "  Assistant     : http://localhost:$SitePort/setup"
Write-Host "  Sauvegardes   : $InstallDir\backups"
Write-Host ""

if (-not $NoLaunch) {
  Start-Process "http://localhost:$SitePort/setup"
}
