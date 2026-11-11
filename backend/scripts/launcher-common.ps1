# Windows PowerShell 5.1+, shared by the three repository launchers.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-TVArgument {
    param([string]$Value)
    if ($Value -match '["\x00-\x1f]') { throw 'Invalid native process argument.' }
    return '"' + [regex]::Replace($Value, '(\\+)$', '$1$1') + '"'
}

function Get-TVQuickOrigins {
    param([string]$Text)
    $pattern = 'https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com(?=$|[\s/"\x27<>|])'
    @([regex]::Matches($Text, $pattern, 'IgnoreCase') | ForEach-Object { $_.Value.ToLowerInvariant() } | Select-Object -Unique)
}

function Initialize-TVPaths {
    param([string]$ProjectRoot)
    $script:TVRoot = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\')
    $script:TVBackend = Join-Path $script:TVRoot 'backend'
    $script:TVRuntime = Join-Path $script:TVBackend '.local\launchers'
    $script:TVStatePath = Join-Path $script:TVRuntime 'state.json'
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($script:TVRoot.ToLowerInvariant()))).Replace('-', '') }
    finally { $sha.Dispose() }
    $script:TVMutex = New-Object Threading.Mutex($false, ('Local\HackathonLauncher-' + $digest))
}

function Invoke-TVLocked {
    param([scriptblock]$Action)
    $held = $false
    try {
        try { $held = $script:TVMutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $held = $true }
        if (-not $held) { throw 'Another launcher operation is busy. Try again shortly.' }
        & $Action
    } finally { if ($held) { $script:TVMutex.ReleaseMutex() } }
}

function Read-TVState {
    Invoke-TVLocked {
        if (-not (Test-Path -LiteralPath $script:TVStatePath)) { return $null }
        $state = [IO.File]::ReadAllText($script:TVStatePath, [Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($state.root -ne $script:TVRoot -or $state.id -notmatch '^[a-f0-9]{32}$') { throw 'Invalid launcher state; refusing to stop processes.' }
        return $state
    }
}

function Save-TVState {
    param($State)
    $temporary = $script:TVStatePath + '.tmp'
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        try {
            [IO.File]::WriteAllText($temporary, ($State | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
            if (Test-Path -LiteralPath $script:TVStatePath) { [IO.File]::Replace($temporary, $script:TVStatePath, [System.Management.Automation.Language.NullString]::Value) }
            else { [IO.File]::Move($temporary, $script:TVStatePath) }
            return
        } catch [IO.IOException] {
            # Windows scanners/readers may briefly deny replacement. Never leave a partial JSON file.
            $win32 = $_.Exception.GetBaseException().HResult -band 0xffff
            if ($attempt -eq 19 -or $win32 -notin @(32,33)) { throw }
            Start-Sleep -Milliseconds 25
        }
    }
}
function Assert-TVCurrent {
    param([string]$Id)
    $state = Read-TVState
    if ($null -eq $state -or $state.id -ne $Id) { throw 'Launch stopped.' }
    return $state
}

function Start-TVChild {
    param([string]$Id, [string]$Role, [string]$Executable, [string[]]$Arguments, [hashtable]$Environment)
    Invoke-TVLocked {
        $state = Assert-TVCurrent $Id
        $runDir = Join-Path $script:TVRuntime $Id
        $marker = if ($Role -eq 'backend') { "--hackathon-launcher=$Id" } else { Join-Path $runDir 'cloudflared.log' }
        $spec = [pscustomobject]@{ role=$Role; exe=$Executable; marker=$marker; pid=0; ticks='' }
        $state.processes = @($state.processes) + $spec
        Save-TVState $state # Record the marker before spawning, for recovery after a host crash.
        $saved = @{}
        try {
            foreach ($key in $Environment.Keys) {
                $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
                [Environment]::SetEnvironmentVariable($key, $Environment[$key], 'Process')
            }
            $nativeArguments = @($Arguments | ForEach-Object { ConvertTo-TVArgument $_ }) -join ' '
            $child = Start-Process -FilePath $Executable -ArgumentList $nativeArguments -WorkingDirectory $script:TVBackend -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runDir "$Role.stdout.log") -RedirectStandardError (Join-Path $runDir "$Role.stderr.log")
            $spec.pid = $child.Id
            $spec.ticks = $child.StartTime.ToUniversalTime().Ticks.ToString()
            try { Save-TVState $state } catch { $child.Kill(); throw }
            return $child
        } finally {
            foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
        }
    }
}

function Stop-TVRun {
    param([string]$ExpectedId = '')
    Invoke-TVLocked {
        $state = Read-TVState
        if ($null -eq $state) { return }
        if ($ExpectedId -and $state.id -ne $ExpectedId) { return }
        $runDir = [IO.Path]::GetFullPath((Join-Path $script:TVRuntime $state.id))
        if ((Split-Path -Parent $runDir) -ne $script:TVRuntime) { throw 'Unsafe runtime directory.' }
        foreach ($spec in @($state.processes)) {
            $expectedExe = if ($spec.role -eq 'backend') { 'node.exe' } elseif ($spec.role -eq 'tunnel') { 'cloudflared.exe' } else { throw 'Invalid child role.' }
            $expectedMarker = if ($spec.role -eq 'backend') { "--hackathon-launcher=$($state.id)" } else { Join-Path $runDir 'cloudflared.log' }
            if ($spec.marker -cne $expectedMarker -or [IO.Path]::GetFileName($spec.exe) -ine $expectedExe) { throw 'Invalid process marker.' }
            $candidates = @(Get-CimInstance Win32_Process -Filter "Name='$expectedExe'" -ErrorAction Stop)
            foreach ($candidate in $candidates) {
                if ($spec.pid -eq 0 -and (-not $candidate.ExecutablePath -or $candidate.ExecutablePath -ieq $spec.exe) -and (-not $candidate.ExecutablePath -or -not $candidate.CommandLine)) {
                    if ($null -eq $candidate.CreationDate -or ([datetime]$candidate.CreationDate).ToUniversalTime() -ge [datetime]::Parse($state.started).ToUniversalTime()) {
                        throw 'Cannot verify a possible child after an interrupted launch. State retained; retry with the same Windows account.'
                    }
                }
                if ($candidate.ExecutablePath -ine $spec.exe -or -not $candidate.CommandLine -or -not $candidate.CommandLine.Contains($expectedMarker)) { continue }
                $process = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
                if ($null -eq $process) { continue }
                if ($spec.pid -ne 0) {
                    if ($process.Id -ne $spec.pid -or $process.StartTime.ToUniversalTime().Ticks.ToString() -cne $spec.ticks) { continue }
                } elseif ($process.StartTime.ToUniversalTime() -lt [datetime]::Parse($state.started).ToUniversalTime()) { continue }
                # Recheck immediately before killing; never kill by executable name alone.
                $check = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)"
                if ($null -ne $check -and $check.ExecutablePath -ieq $spec.exe -and $check.CommandLine -and $check.CommandLine.Contains($expectedMarker)) {
                    try { $process.Kill(); [void]$process.WaitForExit(10000) } catch { if (-not $process.HasExited) { throw } }
                    if (-not $process.HasExited) { throw 'A managed process did not stop; state retained.' }
                }
            }
        }
        # Never discard tracking for a still-live original process that we could not verify.
        foreach ($spec in @($state.processes)) {
            if ($spec.pid -eq 0) { continue }
            $remaining = Get-Process -Id $spec.pid -ErrorAction SilentlyContinue
            if ($null -ne $remaining -and $remaining.StartTime.ToUniversalTime().Ticks.ToString() -ceq $spec.ticks) {
                throw 'An original project process is still alive but could not be safely stopped. State retained.'
            }
        }
        foreach ($name in @('backend.stdout.log','backend.stderr.log','tunnel.stdout.log','tunnel.stderr.log','cloudflared.log','config.yml')) {
            $file = Join-Path $runDir $name
            if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force }
        }
        if ((Test-Path -LiteralPath $runDir) -and @(Get-ChildItem -LiteralPath $runDir -Force).Count -eq 0) { Remove-Item -LiteralPath $runDir }
        Remove-Item -LiteralPath $script:TVStatePath -Force
        if (Test-Path -LiteralPath ($script:TVStatePath + '.tmp')) { Remove-Item -LiteralPath ($script:TVStatePath + '.tmp') -Force }
    }
}

function Stop-TVLauncher {
    param([string]$ProjectRoot)
    Initialize-TVPaths $ProjectRoot
    try { Stop-TVRun; Write-Host 'Managed project launch stopped (or was already stopped).' }
    finally { $script:TVMutex.Dispose() }
}

function Assert-TVPortFree {
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 8787)
    try { $listener.ExclusiveAddressUse = $true; $listener.Start() }
    catch { throw '127.0.0.1:8787 is occupied. Stop its owner yourself, or use stop-demo.ps1 for a managed project launch. No process was terminated.' }
    finally { $listener.Stop() }
}

function Test-TVHealth {
    param([string]$Origin)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "$Origin/api/v1/health" -TimeoutSec 3 -ErrorAction Stop
        $body = $response.Content | ConvertFrom-Json
        return ($response.StatusCode -eq 200 -and $body.data.status -eq 'ok' -and $body.data.database -eq 'ok')
    } catch { $script:TVHealthError = $_.Exception.Message; return $false }
}

function Invoke-TVLauncher {
    param([string]$ProjectRoot, [ValidateSet('Local','Demo')][string]$Mode)
    Initialize-TVPaths $ProjectRoot
    $runId = ''
    $script:TVHealthError = 'Unexpected health response.'
    $originalNodeOptions = [Environment]::GetEnvironmentVariable('NODE_OPTIONS', 'Process')
    [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $null, 'Process')
    $originalTls = [Net.ServicePointManager]::SecurityProtocol
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    try {
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        $version = & $node -p 'process.versions.node'
        if ($LASTEXITCODE -ne 0 -or [version]$version -lt [version]'24.13.0') { throw 'Node.js 24.13.0 or newer is required.' }
        $frontend = Join-Path $script:TVRoot 'Frontend'
        if (-not (Test-Path -LiteralPath (Join-Path $frontend 'index.html'))) { throw 'Frontend/index.html is missing.' }
        # Import dependencies only. This does not open or migrate the database.
        Push-Location $script:TVBackend
        try {
            $probePolicy = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue' # PS5 otherwise turns redirected native stderr into a terminating error.
                & $node --import tsx --input-type=module -e "await import('./src/index.ts'); await import('node:sqlite')" 2>$null
                $probeExit = $LASTEXITCODE
            } finally { $ErrorActionPreference = $probePolicy }
            if ($probeExit -ne 0) { throw 'Backend dependencies are missing/broken. Stop the project, then run npm.cmd --prefix backend ci.' }
        } finally { Pop-Location }
        $cloud = $null
        if ($Mode -eq 'Demo') {
            $command = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
            if ($null -eq $command) { throw 'cloudflared.exe is not installed or is absent from PATH. Install Cloudflare cloudflared, then retry.' }
            $cloud = $command.Source
        }
        Invoke-TVLocked {
            if (Test-Path -LiteralPath $script:TVStatePath) { throw 'A managed launch/state already exists. Run .\stop-demo.ps1 first.' }
            Assert-TVPortFree
            [void][IO.Directory]::CreateDirectory($script:TVRuntime)
            $script:TVNewId = [guid]::NewGuid().ToString('N')
            [void][IO.Directory]::CreateDirectory((Join-Path $script:TVRuntime $script:TVNewId))
            try {
                Save-TVState ([pscustomobject]@{root=$script:TVRoot; id=$script:TVNewId; mode=$Mode; started=[datetime]::UtcNow.ToString('o'); processes=@()})
            } catch {
                $emptyRun = Join-Path $script:TVRuntime $script:TVNewId
                if (@(Get-ChildItem -LiteralPath $emptyRun -Force).Count -eq 0) { Remove-Item -LiteralPath $emptyRun }
                if (Test-Path -LiteralPath ($script:TVStatePath + '.tmp')) { Remove-Item -LiteralPath ($script:TVStatePath + '.tmp') -Force }
                throw
            }
        }
        $runId = $script:TVNewId
        $runDir = Join-Path $script:TVRuntime $runId
        $origin = 'http://localhost:8787'
        $tunnel = $null
        if ($Mode -eq 'Demo') {
            $config = Join-Path $runDir 'config.yml'
            [IO.File]::WriteAllText($config, "{}`n", (New-Object Text.UTF8Encoding($false)))
            $cloudEnv = @{}
            foreach ($item in Get-ChildItem Env:) { if ($item.Name -like 'TUNNEL_*') { $cloudEnv[$item.Name] = $null } }
            $cloudEnv['TUNNEL_TRANSPORT_PROTOCOL'] = 'http2'
            $tunnel = Start-TVChild $runId 'tunnel' $cloud @('tunnel','--config',$config,'--no-autoupdate','--url','http://127.0.0.1:8787','--metrics','127.0.0.1:0','--loglevel','info','--logfile',(Join-Path $runDir 'cloudflared.log')) $cloudEnv
            Write-Host 'Waiting for a fresh Cloudflare Quick Tunnel URL...'
            $deadline = [datetime]::UtcNow.AddSeconds(60)
            do {
                [void](Assert-TVCurrent $runId)
                if ($tunnel.HasExited) { throw 'cloudflared exited before issuing a URL. Check network access and cloudflared installation.' }
                $text = ''
                foreach ($name in @('tunnel.stdout.log','tunnel.stderr.log','cloudflared.log')) {
                    $file = Join-Path $runDir $name
                    if (Test-Path -LiteralPath $file) { $text += (Get-Content -LiteralPath $file -Tail 100 -Encoding UTF8) -join "`n" }
                }
                $origins = @(Get-TVQuickOrigins $text)
                if ($origins.Count -gt 1) { throw 'Cloudflare returned ambiguous URLs; backend was not started.' }
                if ($origins.Count -eq 1) { $origin = $origins[0]; break }
                Start-Sleep -Milliseconds 250
            } while ([datetime]::UtcNow -lt $deadline)
            if ($origins.Count -ne 1) { throw 'No valid Quick Tunnel HTTPS URL within 60 seconds; backend was not started.' }
        }
        $environment = @{NODE_ENV=$(if ($Mode -eq 'Demo') {'production'} else {'development'}); HOST='127.0.0.1'; PORT='8787'; APP_ORIGIN=$origin; FRONTEND_DIR=$frontend; NODE_OPTIONS=$null}
        $backend = Start-TVChild $runId 'backend' $node @('--import','tsx',(Join-Path $script:TVBackend 'src\server.ts'),"--hackathon-launcher=$runId") $environment
        $deadline = [datetime]::UtcNow.AddSeconds(30)
        $ready = $false
        do {
            [void](Assert-TVCurrent $runId)
            if ($backend.HasExited) { throw 'Backend exited during startup. Check dependencies and database configuration; no seed/bootstrap was run.' }
            if ($null -ne $tunnel -and $tunnel.HasExited) { throw 'Cloudflare tunnel exited during startup.' }
            $connections = @(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)
            if ($connections.Count -gt 0) {
                if (@($connections | Where-Object { $_.OwningProcess -ne $backend.Id -or $_.LocalAddress -ne '127.0.0.1' }).Count -gt 0) { throw 'Unexpected port owner or non-loopback listener. Refusing this launch.' }
                if (Test-TVHealth 'http://127.0.0.1:8787') { $ready=$true; break }
            }
            Start-Sleep -Milliseconds 250
        } while ([datetime]::UtcNow -lt $deadline)
        if (-not $ready) { throw 'Backend health check timed out.' }
        if ($Mode -eq 'Demo') {
            $deadline = [datetime]::UtcNow.AddSeconds(60)
            $publicReady = $false
            do {
                [void](Assert-TVCurrent $runId)
                if ($tunnel.HasExited -or $backend.HasExited) { throw 'A project process exited before the public health check.' }
                if (Test-TVHealth $origin) { $publicReady=$true; break }
                Start-Sleep -Milliseconds 500
            } while ([datetime]::UtcNow -lt $deadline)
            if (-not $publicReady) { throw "Public HTTPS health check timed out: $script:TVHealthError Check DNS/network access. Tunnel and backend will be stopped." }
        }
        Write-Host "Ready: $origin"
        Write-Host 'Keep this terminal open. Ctrl+C or .\stop-demo.ps1 stops this launch.'
        while ($true) {
            $state = Read-TVState
            if ($null -eq $state -or $state.id -ne $runId) { break }
            if ($backend.HasExited) { throw 'Backend exited. Stopping the project launch.' }
            if ($null -ne $tunnel -and $tunnel.HasExited) { throw 'Cloudflare tunnel exited. Stopping the backend.' }
            Start-Sleep -Milliseconds 500
        }
    } finally {
        try { if ($runId) { Stop-TVRun $runId } }
        finally {
            [Environment]::SetEnvironmentVariable('NODE_OPTIONS', $originalNodeOptions, 'Process')
            [Net.ServicePointManager]::SecurityProtocol = $originalTls
            $script:TVMutex.Dispose()
        }
    }
}
