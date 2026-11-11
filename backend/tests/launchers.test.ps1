# Self-contained launcher checks. Run with Windows PowerShell 5.1 or newer.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$files = @(
    (Join-Path $root 'start-local.ps1'),
    (Join-Path $root 'start-demo.ps1'),
    (Join-Path $root 'stop-demo.ps1'),
    (Join-Path $root 'backend\scripts\launcher-common.ps1')
)

foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Missing launcher file: $file"
    }
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) {
        throw "PowerShell syntax errors in ${file}: $($errors -join '; ')"
    }
}

. (Join-Path $root 'backend\scripts\launcher-common.ps1')

function Assert-Origins {
    param([string]$Text, [string[]]$Expected)
    $actual = @(Get-TVQuickOrigins -Text $Text)
    if ($actual.Count -ne $Expected.Count) {
        throw "Expected $($Expected.Count) origins, got $($actual.Count) for: $Text"
    }
    for ($i = 0; $i -lt $Expected.Count; $i++) {
        if ($actual[$i] -cne $Expected[$i]) {
            throw "Expected origin '$($Expected[$i])', got '$($actual[$i])'"
        }
    }
}

Assert-Origins -Text 'connection pending' -Expected @()
Assert-Origins -Text '' -Expected @()
Assert-Origins -Text 'https://-invalid.trycloudflare.com' -Expected @()
Assert-Origins -Text 'https://invalid-.trycloudflare.com' -Expected @()
Assert-Origins -Text ('https://' + ('a' * 64) + '.trycloudflare.com') -Expected @()
Assert-Origins -Text 'https://valid.trycloudflare.com_evil' -Expected @()
Assert-Origins -Text 'https://bad_.trycloudflare.com' -Expected @()
Assert-Origins -Text 'https://good.trycloudflare.com.evil.example' -Expected @()
Assert-Origins -Text '{"message":"https://alpha-123.trycloudflare.com"}' -Expected @('https://alpha-123.trycloudflare.com')
Assert-Origins -Text "https://alpha.trycloudflare.com`nhttps://alpha.trycloudflare.com`nhttps://beta.trycloudflare.com" -Expected @('https://alpha.trycloudflare.com', 'https://beta.trycloudflare.com')

if ((ConvertTo-TVArgument -Value '') -cne '""') { throw 'Empty argument was not preserved.' }
if ((ConvertTo-TVArgument -Value 'C:\folder with spaces\file.txt') -cne '"C:\folder with spaces\file.txt"') {
    throw 'Path with spaces was not quoted correctly.'
}
$quoted = ConvertTo-TVArgument -Value 'C:\folder with spaces\'
if ($quoted -cne '"C:\folder with spaces\\"') {
    throw "Incorrect native argument quoting for a trailing backslash: $quoted"
}
$rejected = $false
try {
    [void](ConvertTo-TVArgument -Value 'C:\unsafe"name')
} catch {
    $rejected = $true
}
if (-not $rejected) { throw 'A native argument containing a quote must be rejected.' }

# A foreign live PID with mismatched start ticks must never be stopped.
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('tv-launcher-test-' + [guid]::NewGuid().ToString('N'))
try {
    Initialize-TVPaths $fixtureRoot
    New-Item -ItemType Directory -Path $script:TVRuntime -Force | Out-Null
    $fixtureId = [guid]::NewGuid().ToString('N')
    $state = [pscustomobject]@{
        root = $script:TVRoot; id = $fixtureId; started = [datetime]::UtcNow.ToString('o')
        processes = @([pscustomobject]@{
            role = 'backend'; exe = 'C:\fixture\node.exe'; marker = "--hackathon-launcher=$fixtureId"
            pid = $PID; ticks = '1'
        })
    }
    Save-TVState $state
    for ($i = 0; $i -lt 30; $i++) {
        Invoke-TVLocked { Save-TVState $state }
        if ((Read-TVState).id -cne $fixtureId) { throw 'State replacement/read failed.' }
    }
    Stop-TVRun -ExpectedId $fixtureId
    if ($null -eq (Get-Process -Id $PID -ErrorAction SilentlyContinue)) { throw 'Foreign process stopped.' }
    if (Test-Path -LiteralPath $script:TVStatePath) { throw 'Stale fixture state was not cleaned up.' }
} finally {
    if ($null -ne $script:TVMutex) { $script:TVMutex.Dispose() }
    $fullFixture = [IO.Path]::GetFullPath($fixtureRoot)
    $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if ((Split-Path -Parent $fullFixture) -ne $tempParent -or (Split-Path -Leaf $fullFixture) -notmatch '^tv-launcher-test-[a-f0-9]{32}$') { throw 'Unsafe fixture cleanup path.' }
    if (Test-Path -LiteralPath $fullFixture) { Remove-Item -LiteralPath $fullFixture -Recurse -Force }
}

Write-Host 'Launcher syntax and helper checks passed.'
