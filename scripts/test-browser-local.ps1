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
$env:CI_E2E_BASE_URL = ''
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$envFile = Join-Path $repoRoot '.env.local'
if (Test-Path -LiteralPath $envFile) {
  $configuredUrlLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^NEXT_PUBLIC_SUPABASE_URL=' } | Select-Object -First 1
  if ($configuredUrlLine) {
    $configuredUrl = $configuredUrlLine.Substring('NEXT_PUBLIC_SUPABASE_URL='.Length).Trim().Trim('"')
    if ($configuredUrl -eq $localUrl) {
      $existingApp = 'http://localhost:3000'
      try {
        $existingResponse = Invoke-WebRequest -UseBasicParsing -Uri "$existingApp/login" -TimeoutSec 3
        if ($existingResponse.StatusCode -eq 200 -and $existingResponse.Content.Contains('Ephis ID')) { $env:CI_E2E_BASE_URL = $existingApp }
      } catch { }
    }
  }
}
$ready = $false
for ($attempt = 0; $attempt -lt 25; $attempt++) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$localUrl/auth/v1/health" -Headers @{ apikey = $publishable } -TimeoutSec 3
    if ($response.StatusCode -eq 200) { $ready = $true; break }
  } catch { Start-Sleep -Seconds 2 }
}
if (-not $ready) { throw 'Local Supabase Auth did not become ready.' }
if ($env:CI_E2E_BASE_URL) {
  Write-Output 'Using the existing repository dev server for synthetic browser E2E (credentials omitted).'
} else {
  Remove-Item Env:CI_E2E_BASE_URL -ErrorAction SilentlyContinue
  Write-Output 'Starting the isolated local app server for synthetic browser E2E (credentials omitted).'
}
npx playwright test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
