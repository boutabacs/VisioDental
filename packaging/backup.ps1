# Sauvegarde quotidienne de la base VisioDental (pg_dump format custom).
# Enregistré par install-server.ps1 comme tâche planifiée « VisioDental Backup ».
#
#   powershell -ExecutionPolicy Bypass -File backup.ps1 -InstallDir "C:\Program Files\VisioDental"

param(
  [string]$InstallDir = "C:\Program Files\VisioDental",
  [int]$Keep = 14
)

$ErrorActionPreference = "Stop"

function Write-Log([string]$Message) {
  $stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  $line = "$stamp  $Message"
  Write-Output $line
  Add-Content -Path (Join-Path $InstallDir "backups\backup.log") -Value $line -Encoding UTF8
}

try {
  $envFile = Join-Path $InstallDir ".env"
  if (-not (Test-Path $envFile)) { throw "Fichier .env introuvable : $envFile" }

  $databaseUrl = (Get-Content $envFile | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1)
  if (-not $databaseUrl) { throw "DATABASE_URL absent de .env" }
  $databaseUrl = $databaseUrl.Substring("DATABASE_URL=".Length).Trim()

  $match = [regex]::Match(
    $databaseUrl,
    '^postgresql://(?<user>[^:@/]+):(?<password>[^@]*)@(?<host>[^:/]+):(?<port>\d+)/(?<db>[^?]+)'
  )
  if (-not $match.Success) { throw "DATABASE_URL illisible (format attendu postgresql://user:pass@host:port/db)" }

  $pgDump = Join-Path $InstallDir "pgsql\bin\pg_dump.exe"
  if (-not (Test-Path $pgDump)) { throw "pg_dump introuvable : $pgDump (PostgreSQL externe : adaptez ce script)" }

  $backupDir = Join-Path $InstallDir "backups"
  if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }

  $file = Join-Path $backupDir ("visiodental-" + (Get-Date).ToString("yyyyMMdd-HHmm") + ".dump")
  $env:PGPASSWORD = $match.Groups["password"].Value
  & $pgDump -Fc -f $file `
    -h $match.Groups["host"].Value `
    -p $match.Groups["port"].Value `
    -U $match.Groups["user"].Value `
    $match.Groups["db"].Value
  if ($LASTEXITCODE -ne 0) { throw "pg_dump a échoué (code $LASTEXITCODE)" }

  $sizeMb = [math]::Round((Get-Item $file).Length / 1MB, 2)
  Write-Log "Sauvegarde OK : $file ($sizeMb Mo)"

  Get-ChildItem -Path $backupDir -Filter "visiodental-*.dump" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip $Keep |
    ForEach-Object {
      Remove-Item $_.FullName -Force
      Write-Log "Ancienne sauvegarde supprimée : $($_.Name)"
    }
}
catch {
  Write-Log "ÉCHEC : $($_.Exception.Message)"
  exit 1
}
finally {
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
