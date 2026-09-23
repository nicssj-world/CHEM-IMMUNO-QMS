$ErrorActionPreference = 'Stop'
Write-Output 'Target environment: local disposable Supabase Storage'
cmd.exe /d /s /c 'supabase stop --project-id CHEM-IMMUNO-QMS >NUL 2>&1'
if ($LASTEXITCODE -ne 0) { throw 'Could not stop local Supabase before Storage test reset.' }
cmd.exe /d /s /c 'supabase start >NUL 2>&1'
if ($LASTEXITCODE -ne 0) { throw 'Could not start local Supabase.' }
cmd.exe /d /s /c 'supabase db reset --local --no-seed >NUL 2>&1'
if ($LASTEXITCODE -ne 0) { throw 'Could not reset local Supabase.' }
$values = @{}
foreach ($line in (cmd.exe /d /s /c 'supabase status --output env 2>NUL')) {
  if ($line -match '^([A-Z0-9_]+)=(.*)$') {
    $setting = $Matches[2].Trim().Trim('"')
    $values[$Matches[1]] = $setting
  }
}
$url = $values['API_URL']
if (-not $url) { $url = $values['SUPABASE_URL'] }
$publishable = $values['PUBLISHABLE_KEY']
if (-not $publishable) { $publishable = $values['ANON_KEY'] }
if (-not $url -or -not $publishable -or -not $values['SERVICE_ROLE_KEY'] -or -not $values['DB_URL']) { throw 'Local Supabase settings missing.' }
if (([Uri]$url).Host -notin @('localhost','127.0.0.1','::1') -or ([Uri]$values['DB_URL']).Host -notin @('localhost','127.0.0.1','::1')) { throw 'Refusing non-local Storage test target.' }
$env:NEXT_PUBLIC_SUPABASE_URL = $url
$env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = $publishable
$env:SUPABASE_SERVICE_ROLE_KEY = $values['SERVICE_ROLE_KEY']
$env:CI_LOCAL_DATABASE_URL = $values['DB_URL']
Write-Output "Running Storage integration against $url (credentials omitted)."
node --import tsx --test tests/storage/local-storage.test.ts
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
