<#
.SYNOPSIS
  Installs the Maestro Runner Agent as a Windows service.

.DESCRIPTION
  Uses nssm when it is available (it gives real graceful-stop semantics:
  it sends the console CTRL event and WAITS, which is what lets the agent
  drain its leases). Falls back to sc.exe otherwise.

  The agent runs as a DEDICATED NON-ADMIN local account. On Windows there is no
  container isolation for MSBuild, so "ephemeral user + narrow rights" IS the
  isolation — an agent running as LocalSystem would remove it entirely.

  The shared secret is stored with DPAPI, encrypted to the service account, and
  never written into the service's environment (any admin can read that).

.EXAMPLE
  .\install-windows.ps1 -PlatformUrl https://maestro.internal -AgentId win-build-02
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PlatformUrl,
  [Parameter(Mandatory = $true)][string]$AgentId,
  [string]$TokenKey = "MAESTRO_AGENT_TOKEN",
  [int]$Capacity = 2,
  [string]$Labels = "",
  [string]$AgentVersion = "0.1.0",
  [string]$ServiceName = "MaestroRunnerAgent",
  [string]$InstallDir = "C:\Program Files\Maestro\runner-agent",
  [string]$WorkDir = "C:\ProgramData\Maestro\agent",
  [string]$AccountName = "maestro-agent"
)

$ErrorActionPreference = "Stop"

# ── preconditions (fail closed) ──────────────────────────────────────────
if (-not $PlatformUrl.StartsWith("https://")) {
  throw "-PlatformUrl must be https: the shared secret would otherwise cross the wire in the clear."
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "This installer must run in an elevated session."
}
$node = (Get-Command node -ErrorAction SilentlyContinue)
if ($null -eq $node) { throw "node is not on PATH." }

# ── dedicated non-admin service account ──────────────────────────────────
$account = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
if ($null -eq $account) {
  Write-Host "Creating service account $AccountName"
  # Random password: nobody needs to know it — the service logs on with it,
  # and it is never used interactively.
  $bytes = [byte[]]::new(32)
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $plain = [Convert]::ToBase64String($bytes) + "!aA1"
  $password = ConvertTo-SecureString $plain -AsPlainText -Force
  New-LocalUser -Name $AccountName -Password $password -FullName "Maestro Runner Agent" `
    -Description "Runs Maestro sandboxed build jobs" -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
  # Deliberately NOT added to Administrators — that is the isolation.
  $script:AccountPassword = $plain
} else {
  Write-Host "Service account $AccountName already exists; reusing it."
  $script:AccountPassword = Read-Host -AsSecureString "Enter the existing $AccountName password" |
    ForEach-Object { [Runtime.InteropServices.Marshal]::PtrToStringAuto(
      [Runtime.InteropServices.Marshal]::SecureStringToBSTR($_)) }
}

# ── directories ──────────────────────────────────────────────────────────
foreach ($dir in @($InstallDir, $WorkDir)) {
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}
# The work directory holds cloned source and build output: the service account
# owns it, everyone else is kept out.
$acl = Get-Acl $WorkDir
$acl.SetAccessRuleProtection($true, $false)
$acl.SetAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
  $AccountName, "Modify", "ContainerInherit,ObjectInherit", "None", "Allow")))
$acl.SetAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
  "Administrators", "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")))
Set-Acl -Path $WorkDir -AclObject $acl

# ── application files ────────────────────────────────────────────────────
$sourceDir = Split-Path -Parent $PSScriptRoot
robocopy $sourceDir $InstallDir /MIR /XD node_modules test .turbo /XF *.test.ts | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying application files failed (robocopy $LASTEXITCODE)." }
$global:LASTEXITCODE = 0

# ── shared secret, DPAPI-encrypted to the service account ────────────────
$secretPath = Join-Path $WorkDir "agent-token.dpapi"
if (-not (Test-Path $secretPath)) {
  Write-Host ""
  Write-Host "Paste the shared secret issued for '$AgentId' by the Maestro platform."
  $secret = Read-Host -AsSecureString "Shared secret"
  $plainSecret = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret))

  # Encrypted under the SERVICE ACCOUNT's DPAPI scope, so an operator who can
  # read the file still cannot decrypt it.
  $encodeScript = @"
`$bytes = [Text.Encoding]::UTF8.GetBytes('$plainSecret')
`$blob = [Security.Cryptography.ProtectedData]::Protect(`$bytes, `$null, 'CurrentUser')
[IO.File]::WriteAllBytes('$secretPath', `$blob)
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($encodeScript))
  $credential = New-Object Management.Automation.PSCredential(
    ".\$AccountName", (ConvertTo-SecureString $script:AccountPassword -AsPlainText -Force))
  Start-Process powershell.exe -Credential $credential -ArgumentList @(
    "-NoProfile", "-NonInteractive", "-EncodedCommand", $encoded) -Wait -WindowStyle Hidden
  if (-not (Test-Path $secretPath)) { throw "Could not store the shared secret." }
  Write-Host "Shared secret stored (DPAPI, service account scope)."
}

# Launcher decrypts at start time and passes the value in-process only.
$launcher = Join-Path $InstallDir "run-agent.ps1"
@"
`$ErrorActionPreference = 'Stop'
`$blob = [IO.File]::ReadAllBytes('$secretPath')
`$bytes = [Security.Cryptography.ProtectedData]::Unprotect(`$blob, `$null, 'CurrentUser')
`$env:$TokenKey = [Text.Encoding]::UTF8.GetString(`$bytes)
& '$($node.Source)' --experimental-strip-types '$InstallDir\src\main.ts'
"@ | Set-Content -Path $launcher -Encoding UTF8

# ── service registration ─────────────────────────────────────────────────
$serviceEnv = @{
  "NODE_ENV"                    = "production"
  "MAESTRO_AGENT_PLATFORM_URL"  = $PlatformUrl
  "MAESTRO_AGENT_ID"            = $AgentId
  "MAESTRO_AGENT_PLATFORM"      = "windows-dotnet"
  "MAESTRO_AGENT_VERSION"       = $AgentVersion
  "MAESTRO_AGENT_CAPACITY"      = "$Capacity"
  "MAESTRO_AGENT_LABELS"        = $Labels
  "MAESTRO_AGENT_WORK_DIR"      = $WorkDir
  "MAESTRO_AGENT_TOKEN_SOURCE"  = "env"
  "MAESTRO_AGENT_TOKEN_KEY"     = $TokenKey
}

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  Write-Host "Removing the existing service first."
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 2
}

$nssm = (Get-Command nssm -ErrorAction SilentlyContinue)
if ($null -ne $nssm) {
  Write-Host "Registering with nssm."
  & $nssm.Source install $ServiceName "powershell.exe" `
    "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcher`"" | Out-Null
  & $nssm.Source set $ServiceName AppDirectory $WorkDir | Out-Null
  & $nssm.Source set $ServiceName DisplayName "Maestro Runner Agent" | Out-Null
  & $nssm.Source set $ServiceName Description "Runs Maestro sandboxed build jobs (outbound only)" | Out-Null
  & $nssm.Source set $ServiceName ObjectName ".\$AccountName" $script:AccountPassword | Out-Null
  & $nssm.Source set $ServiceName Start SERVICE_AUTO_START | Out-Null
  # Console CTRL event, then wait: this is what makes the drain real.
  & $nssm.Source set $ServiceName AppStopMethodConsole 120000 | Out-Null
  & $nssm.Source set $ServiceName AppStdout (Join-Path $WorkDir "runner-agent.log") | Out-Null
  & $nssm.Source set $ServiceName AppStderr (Join-Path $WorkDir "runner-agent.err.log") | Out-Null
  foreach ($pair in $serviceEnv.GetEnumerator()) {
    & $nssm.Source set $ServiceName AppEnvironmentExtra "$($pair.Key)=$($pair.Value)" | Out-Null
  }
} else {
  Write-Warning "nssm not found — falling back to sc.exe (stop is less graceful)."
  $binPath = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcher`""
  sc.exe create $ServiceName binPath= $binPath start= auto obj= ".\$AccountName" `
    password= $script:AccountPassword DisplayName= "Maestro Runner Agent" | Out-Null
  # sc.exe has no per-service environment: it goes on the service key instead.
  $regPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
  $multi = $serviceEnv.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }
  New-ItemProperty -Path $regPath -Name "Environment" -PropertyType MultiString -Value $multi -Force | Out-Null
  sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
}

# "Log on as a service" — without it the account cannot start the service at all.
$tmp = [IO.Path]::GetTempFileName()
secedit /export /cfg $tmp /areas USER_RIGHTS | Out-Null
$sid = (New-Object Security.Principal.NTAccount($AccountName)).Translate(
  [Security.Principal.SecurityIdentifier]).Value
$content = Get-Content $tmp
$line = $content | Where-Object { $_ -like "SeServiceLogonRight*" }
if ($line -notmatch [regex]::Escape($sid)) {
  $updated = if ($line) { $content -replace [regex]::Escape($line), "$line,*$sid" }
             else { $content -replace "\[Privilege Rights\]", "[Privilege Rights]`r`nSeServiceLogonRight = *$sid" }
  $cfg = [IO.Path]::GetTempFileName()
  $updated | Set-Content $cfg
  secedit /configure /db secedit.sdb /cfg $cfg /areas USER_RIGHTS | Out-Null
  Remove-Item $cfg -Force
}
Remove-Item $tmp -Force

Start-Service -Name $ServiceName
Write-Host ""
Write-Host "Installed. Status:  Get-Service $ServiceName"
Write-Host "Logs:               Get-Content '$WorkDir\runner-agent.log' -Tail 50 -Wait"
