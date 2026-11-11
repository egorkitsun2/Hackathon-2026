#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'backend\scripts\launcher-common.ps1')
    Invoke-TVLauncher -ProjectRoot $PSScriptRoot -Mode Local
} catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
}
