<# : batch part
@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f='%~f0'; iex ([IO.File]::ReadAllText($f))"
pause
exit /b
#>
# ---------------------------------------------------------------------------
# Lampa VLC: registers the vlcpl:// link for the current user (no admin needed).
# Clicking vlcpl://play?ts=...&hash=...&index=... in Lampa opens VLC with a
# playlist of the series starting from the selected episode.
# Uninstall: reg delete HKCU\Software\Classes\vlcpl /f
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'

$dir     = Join-Path $env:LOCALAPPDATA 'LampaVLC'
$handler = Join-Path $dir 'vlcpl-handler.ps1'
New-Item -ItemType Directory -Path $dir -Force | Out-Null

$code = @'
param([string]$Uri)
$ErrorActionPreference = 'Stop'

function Fail($msg) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($msg, 'Lampa VLC') | Out-Null
    exit 1
}

function Find-Vlc {
    if ($env:LAMPA_VLC_EXE -and (Test-Path $env:LAMPA_VLC_EXE)) { return $env:LAMPA_VLC_EXE }
    foreach ($k in 'HKLM:\SOFTWARE\VideoLAN\VLC', 'HKLM:\SOFTWARE\WOW6432Node\VideoLAN\VLC') {
        try {
            $p = Get-ItemProperty -Path $k -ErrorAction Stop
            if ($p.'(default)' -and (Test-Path $p.'(default)')) { return $p.'(default)' }
            if ($p.InstallDir) { $e = Join-Path $p.InstallDir 'vlc.exe'; if (Test-Path $e) { return $e } }
        } catch {}
    }
    foreach ($e in "$env:ProgramFiles\VideoLAN\VLC\vlc.exe", "${env:ProgramFiles(x86)}\VideoLAN\VLC\vlc.exe") {
        if ($e -and (Test-Path $e)) { return $e }
    }
    return $null
}

# --- parse vlcpl://play?ts=<base>&hash=<hash>&index=<n> ---
if ($Uri -notmatch '^vlcpl://[^?]*\?(.+)$') { Fail "Bad link: $Uri" }
$q = @{}
foreach ($pair in ($Matches[1].TrimEnd('/') -split '&')) {
    $kv = $pair -split '=', 2
    if ($kv.Count -eq 2) { $q[$kv[0]] = [uri]::UnescapeDataString($kv[1]) }
}
$base  = ([string]$q['ts']).TrimEnd('/')
$hash  = [string]$q['hash']
$index = -1
if ($q['index'] -match '^\d+$') { $index = [int]$q['index'] }

# only local TorrServer, only a plain torrent hash
if ($base -notmatch '^https?://([^/:]+)(:\d+)?$') { Fail "Bad TorrServer address: $base" }
$h = $Matches[1]
$local = ($h -eq 'localhost') -or ($h -match '^127\.') -or ($h -match '^10\.') -or
         ($h -match '^192\.168\.') -or ($h -match '^172\.(1[6-9]|2\d|3[01])\.') -or ($h -match '\.local$')
$allowFile = Join-Path $PSScriptRoot 'allowed-hosts.txt'
if (-not $local -and (Test-Path $allowFile)) {
    $allowed = @(Get-Content $allowFile | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ -and -not $_.StartsWith('#') })
    if ($allowed -contains $h.ToLower()) { $local = $true }
}
if (-not $local) { Fail "TorrServer is not in the local network: $h`r`nAdd it to $allowFile" }
if ($hash -notmatch '^[A-Za-z0-9]{32,40}$') { Fail "Bad torrent hash: $hash" }

$vlc = Find-Vlc
if (-not $vlc) { Fail 'VLC not found. Install VLC from videolan.org' }

# --- build playlist from TorrServer file list ---
$target = "$base/playlist?hash=$hash"
try {
    $st = Invoke-RestMethod -Uri "$base/stream/fname?link=$hash&stat" -TimeoutSec 15
    $files = @($st.file_stats | Where-Object { $_.path -match '\.(mkv|mp4|avi|m4v|mov|ts|m2ts|webm|wmv|mpg|mpeg|flv)$' } |
        Sort-Object { [regex]::Replace($_.path, '\d+', { param($m) $m.Value.PadLeft(10, '0') }) })
    if ($files.Count -gt 0) {
        $start = 0
        for ($i = 0; $i -lt $files.Count; $i++) { if ([int]$files[$i].id -eq $index) { $start = $i; break } }
        $lines = New-Object System.Collections.Generic.List[string]
        $lines.Add('#EXTM3U')
        for ($i = $start; $i -lt $files.Count; $i++) {
            $name = ($files[$i].path -split '/')[-1]
            $lines.Add("#EXTINF:-1,$name")
            $lines.Add("$base/stream/$([uri]::EscapeDataString($name))?link=$hash&index=$($files[$i].id)&play")
        }
        $tmp = Join-Path $env:TEMP 'lampa-vlc.m3u8'
        [IO.File]::WriteAllLines($tmp, $lines, (New-Object System.Text.UTF8Encoding $false))
        $target = $tmp
    }
} catch {
    # TorrServer did not answer with a file list: fall back to its own playlist
}

Start-Process -FilePath $vlc -ArgumentList ('"' + $target + '"')
'@
[IO.File]::WriteAllText($handler, $code, (New-Object System.Text.UTF8Encoding $false))
$allowFile = Join-Path $dir 'allowed-hosts.txt'
if (-not (Test-Path $allowFile)) {
    [IO.File]::WriteAllText($allowFile, "# Remote TorrServer hosts allowed for vlcpl:// (one per line)`r`n", (New-Object System.Text.UTF8Encoding $false))
}

# --- register vlcpl:// for the current user ---
$key = 'HKCU:\Software\Classes\vlcpl'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value 'URL:Lampa VLC'
Set-ItemProperty -Path $key -Name 'URL Protocol' -Value ''
New-Item -Path "$key\shell\open\command" -Force | Out-Null
$cmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $handler + '" "%1"'
Set-ItemProperty -Path "$key\shell\open\command" -Name '(default)' -Value $cmd

Write-Host ''
Write-Host 'OK: vlcpl:// link registered.' -ForegroundColor Green
Write-Host "Handler: $handler"
$vlcFound = $false
foreach ($e in "$env:ProgramFiles\VideoLAN\VLC\vlc.exe", "${env:ProgramFiles(x86)}\VideoLAN\VLC\vlc.exe") { if ($e -and (Test-Path $e)) { Write-Host "VLC: $e"; $vlcFound = $true } }
if (-not $vlcFound) { Write-Host 'VLC not found in Program Files (it will also be searched in the registry).' -ForegroundColor Yellow }
Write-Host ''
Write-Host 'Now in Lampa: Settings -> VLC playlist -> Method -> vlcpl:// link'
