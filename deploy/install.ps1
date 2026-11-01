# Runs mgu-install without Node: downloads the standalone executable for
# this computer from the `installer` release, checks it against the
# release's SHA256SUMS, and runs it with the arguments given here
# (deploy/README.md, "mgu-install"). Windows PowerShell 5.1 or PowerShell 7:
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.ps1))) first-install --identity $HOME\.ssh\mgu_root_key
#
# $env:MGU_INSTALL_DOWNLOAD names another folder of the same files (a URL).
# mgu-install's exit status is left in $LASTEXITCODE (the script's exit
# status when run as a file); 1 when it could not be fetched.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$base = $env:MGU_INSTALL_DOWNLOAD
if (-not $base) { $base = 'https://github.com/robertnisipeanu/mgu-store/releases/download/installer' }
$asFile = [bool]$MyInvocation.MyCommand.Path

function Fail($message) {
    [Console]::Error.WriteLine("mgu-install: $message")
    $global:LASTEXITCODE = 1
    if ($asFile) { exit 1 }
}

# One argument as the Windows C runtime reads it back.
function Quote([string]$a) {
    if ($a -ne '' -and $a -notmatch '[\s"]') { return $a }
    $a = [regex]::Replace($a, '(\\*)"', '$1$1\"')
    return '"' + [regex]::Replace($a, '(\\+)$', '$1$1') + '"'
}

function Run([string[]]$argv) {
    $cpu = $env:PROCESSOR_ARCHITEW6432
    if (-not $cpu) { $cpu = $env:PROCESSOR_ARCHITECTURE }
    $cpu = @{ AMD64 = 'x64'; ARM64 = 'arm64' }[$cpu]
    if ([Environment]::OSVersion.Platform -ne 'Win32NT') {
        return Fail 'this script is for Windows; on macOS and Linux run install.sh (deploy/README.md)'
    }
    if (-not $cpu) {
        return Fail "no executable for $env:PROCESSOR_ARCHITECTURE; run mgu-install.js with Node 18+ instead (deploy/README.md)"
    }
    $name = "mgu-install-windows-$cpu.exe.gz"
    $dir = Join-Path ([IO.Path]::GetTempPath()) ('mgu-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $dir | Out-Null
    try {
        try {
            Invoke-WebRequest "$base/SHA256SUMS" -OutFile "$dir\SHA256SUMS" -UseBasicParsing
        } catch {
            return Fail "could not download $base/SHA256SUMS: $($_.Exception.Message)"
        }
        $want = $null
        foreach ($line in Get-Content "$dir\SHA256SUMS") {
            $f = $line -split '\s+', 2
            if ($f.Count -eq 2 -and $f[1].TrimStart('*') -eq $name) { $want = $f[0].ToLower() }
        }
        if (-not $want) { return Fail "$base/SHA256SUMS lists no $name" }
        try {
            Invoke-WebRequest "$base/$name" -OutFile "$dir\$name" -UseBasicParsing
        } catch {
            return Fail "could not download $base/${name}: $($_.Exception.Message)"
        }
        $got = (Get-FileHash -Algorithm SHA256 "$dir\$name").Hash.ToLower()
        if ($got -ne $want) {
            return Fail "$name does not match SHA256SUMS (sha256 $got, expected $want); nothing was run. Try again in a minute"
        }
        $exe = "$dir\mgu-install.exe"
        $in = [IO.File]::OpenRead("$dir\$name")
        try {
            $gz = New-Object IO.Compression.GZipStream($in, [IO.Compression.CompressionMode]::Decompress)
            $out = [IO.File]::Create($exe)
            try { $gz.CopyTo($out) } finally { $out.Dispose() }
        } finally {
            $in.Dispose()
        }

        $start = New-Object Diagnostics.ProcessStartInfo $exe
        $start.Arguments = (@($argv) | ForEach-Object { Quote $_ }) -join ' '
        $start.UseShellExecute = $false
        $p = [Diagnostics.Process]::Start($start)
        $p.WaitForExit()
        $global:LASTEXITCODE = $p.ExitCode
        if ($asFile) { exit $p.ExitCode }
    } finally {
        Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
    }
}

Run $args
