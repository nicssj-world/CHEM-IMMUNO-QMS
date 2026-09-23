$ErrorActionPreference = 'Stop'

function Read-LocalValues($lines) {
  $values = @{}
  foreach ($line in $lines) {
    if ($line -match '^([A-Z0-9_]+)=(.*)$') {
      $value = $Matches[2].Trim()
      if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) { $value = $value.Substring(1,$value.Length-2) }
      $values[$Matches[1]] = $value
    }
  }
  return $values
}

Write-Output 'Target environment: local disposable Supabase'
$statusLines = cmd.exe /d /s /c 'supabase status --output env 2>NUL'
$localValues = Read-LocalValues $statusLines
if ($localValues['API_URL'] -and $localValues['PUBLISHABLE_KEY'] -and $localValues['SERVICE_ROLE_KEY']) {
  cmd.exe /d /s /c 'supabase stop --project-id CHEM-IMMUNO-QMS >NUL 2>&1'
  if ($LASTEXITCODE -ne 0) { throw 'Could not stop the local Supabase project before its destructive test reset.' }
}
cmd.exe /d /s /c 'supabase start >NUL 2>&1'
if ($LASTEXITCODE -ne 0) { throw 'Could not start local Supabase containers.' }

cmd.exe /d /s /c 'supabase db reset --local --no-seed >NUL 2>&1'
$resetExitCode = $LASTEXITCODE
if ($resetExitCode -ne 0) { throw 'Could not reset the local Supabase database from migrations.' }

$statusLines = cmd.exe /d /s /c 'supabase status --output env 2>NUL'
if ($LASTEXITCODE -ne 0) { throw 'Could not read local Supabase environment settings.' }
$localValues = Read-LocalValues $statusLines
$localUrl = $localValues['API_URL']
if (-not $localUrl) { $localUrl = $localValues['SUPABASE_URL'] }
$localPublishableKey = $localValues['PUBLISHABLE_KEY']
if (-not $localPublishableKey) { $localPublishableKey = $localValues['ANON_KEY'] }
$localServiceKey = $localValues['SERVICE_ROLE_KEY']
if (-not $localServiceKey) { $localServiceKey = $localValues['SUPABASE_SERVICE_ROLE_KEY'] }
if (-not $localUrl -or -not $localPublishableKey -or -not $localServiceKey) {
  throw 'Local Supabase did not return the required URL, publishable key, and service-role key.'
}
$localHost = ([Uri]$localUrl).Host
if ($localHost -notin @('localhost','127.0.0.1','::1')) { throw 'Refusing to run local Auth tests against a non-loopback Supabase URL.' }

$env:NEXT_PUBLIC_SUPABASE_URL = $localUrl
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = $localPublishableKey
$env:SUPABASE_SERVICE_ROLE_KEY = $localServiceKey
Write-Output "Running Auth integration against $localUrl (credentials omitted)."
node --import tsx --test tests/auth/*.test.ts
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
