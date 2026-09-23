$ErrorActionPreference = 'Stop'
$containerName = 'chem-immuno-phase1-test'
$databaseUrl = $null

docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'Docker Desktop must be running to start the disposable PostgreSQL test container.'
}

$found = docker ps -a --filter "name=^/$containerName$" --format '{{.Names}}'
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect local Docker containers.' }
if ($found -eq $containerName) {
  $containerEnvironment = docker inspect --format '{{json .Config.Env}}' $containerName | ConvertFrom-Json
  $passwordSetting = $containerEnvironment | Where-Object { $_.StartsWith('POSTGRES_PASSWORD=') } | Select-Object -First 1
  if ($passwordSetting) {
    $databasePassword = $passwordSetting.Substring('POSTGRES_PASSWORD='.Length)
    $databaseUrl = "postgresql://postgres:$databasePassword@127.0.0.1:55442/postgres"
  } else {
    $databaseUrl = 'postgresql://postgres@127.0.0.1:55442/postgres'
  }
  $running = docker inspect --format '{{.State.Running}}' $containerName
  if ($running -ne 'true') { docker start $containerName | Out-Null }
} else {
  $randomBytes = New-Object byte[] 32
  $randomGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $randomGenerator.GetBytes($randomBytes)
  $randomGenerator.Dispose()
  $databasePassword = [BitConverter]::ToString($randomBytes).Replace('-', '').ToLowerInvariant()
  docker run --name $containerName -e "POSTGRES_PASSWORD=$databasePassword" -p 127.0.0.1:55442:5432 -d postgres:17 | Out-Null
  $databaseUrl = "postgresql://postgres:$databasePassword@127.0.0.1:55442/postgres"
}
if ($LASTEXITCODE -ne 0) { throw 'Could not start disposable PostgreSQL.' }

$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  docker exec $containerName pg_isready -U postgres *> $null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ready) { throw 'Disposable PostgreSQL did not become ready within 60 seconds.' }

$env:CI_TEST_DATABASE_URL = $databaseUrl
npm run test:db
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
