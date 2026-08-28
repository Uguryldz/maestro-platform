<#
.SYNOPSIS
  Removes the Maestro Runner Agent Windows service.

.DESCRIPTION
  Stops the service first and waits, so the agent drains its leases and
  deregisters rather than leaving the platform to time them out.

  The work directory and the service account are KEPT by default: the work
  directory holds ticket workspaces, and removing one is an audited operation
  on the platform side (M31/M65). Pass -Purge when decommissioning the machine.
#>
[CmdletBinding()]
param(
  [string]$ServiceName = "MaestroRunnerAgent",
  [string]$InstallDir = "C:\Program Files\Maestro\runner-agent",
  [string]$WorkDir = "C:\ProgramData\Maestro\agent",
  [string]$AccountName = "maestro-agent",
  [switch]$Purge
)

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole(
      [Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "This uninstaller must run in an elevated session."
}

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -ne $service) {
  if ($service.Status -ne "Stopped") {
    Write-Host "Stopping $ServiceName (draining leases)…"
    $nssm = Get-Command nssm -ErrorAction SilentlyContinue
    if ($null -ne $nssm) {
      # Honours AppStopMethodConsole, so the agent gets its graceful window.
      & $nssm.Source stop $ServiceName | Out-Null
    } else {
      Stop-Service -Name $ServiceName -Force
    }
    # Give the drain time to finish before the files are removed.
    $deadline = (Get-Date).AddSeconds(130)
    while ((Get-Service -Name $ServiceName).Status -ne "Stopped" -and (Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 2
    }
  }

  $nssm = Get-Command nssm -ErrorAction SilentlyContinue
  if ($null -ne $nssm) { & $nssm.Source remove $ServiceName confirm | Out-Null }
  else { sc.exe delete $ServiceName | Out-Null }
  Start-Sleep -Seconds 2
}

if (Test-Path $InstallDir) { Remove-Item -Path $InstallDir -Recurse -Force }

if ($Purge) {
  Write-Host "Purging work directory and service account."
  if (Test-Path $WorkDir) { Remove-Item -Path $WorkDir -Recurse -Force }
  if (Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue) {
    Remove-LocalUser -Name $AccountName
  }
} else {
  Write-Host "Kept $WorkDir and the $AccountName account (use -Purge to remove them)."
}

Write-Host "Uninstalled."
