$ErrorActionPreference = 'Stop'
Write-Output 'Target environment: local disposable Supabase + local Chromium'
cmd.exe /d /s /c 'supabase stop --project-id CHEM-IMMUNO-QMS >NUL 2>&1'
if ($LASTEXITCODE -ne 0) { throw 'Could not stop the local Supabase stack.' }
cmd.exe /d /s /c 'supabase start >NUL 2>&1'
if ($LASTEXITCODE -ne 0) { throw 'Local Supabase did not start.' }
cmd.exe /d /s /c 'supabase db reset --local --no-seed >NUL 2>&1'
if ($LASTEXITCODE -ne 0) { throw 'Local Supabase reset failed.' }
$values = @{}
foreach ($line in (cmd.exe /d /s /c 'supabase status --output env 2>NUL')) {
  if ($line -match '^([A-Z0-9_]+)=(.*)$') {
    $v = $Matches[2].Trim().Trim('"')
    $values[$Matches[1]] = $v
  }
}
$localUrl = if ($values['API_URL']) { $values['API_URL'] } else { $values['SUPABASE_URL'] }
$publishable = if ($values['PUBLISHABLE_KEY']) { $values['PUBLISHABLE_KEY'] } else { $values['ANON_KEY'] }
$service = if ($values['SERVICE_ROLE_KEY']) { $values['SERVICE_ROLE_KEY'] } else { $values['SUPABASE_SERVICE_ROLE_KEY'] }
if (-not $localUrl -or -not $publishable -or -not $service) { throw 'Missing local Supabase credentials.' }
if (([Uri]$localUrl).Host -notin @('localhost','127.0.0.1','::1')) { throw 'Refusing non-local Supabase target.' }
$env:NEXT_PUBLIC_SUPABASE_URL = $localUrl
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = $publishable
$env:SUPABASE_SERVICE_ROLE_KEY = $service
$env:CI_E2E_PASSWORD = 'Local-' + [Guid]::NewGuid().ToString('N') + '-A9!'
$ready = $false
for ($attempt = 0; $attempt -lt 25; $attempt++) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$localUrl/auth/v1/health" -Headers @{ apikey = $publishable } -TimeoutSec 3
    if ($response.StatusCode -eq 200) { $ready = $true; break }
  } catch { Start-Sleep -Seconds 2 }
}
if (-not $ready) { throw 'Local Supabase Auth did not become ready.' }
Write-Output 'Running synthetic browser E2E at 375px, 768px, and desktop (credentials omitted).'
npx playwright test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
