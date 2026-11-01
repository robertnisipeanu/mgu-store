# Tests deploy/install.ps1 on Windows against a folder of the installer
# release's files served at $Base (SHA256SUMS and the executables), in the
# PowerShell running it: the one-liner's scriptblock and a run as a file.
# $BadBase serves a SHA256SUMS the executables do not match.
param([Parameter(Mandatory)] [string]$Base, [Parameter(Mandatory)] [string]$BadBase)

# mgu-install's messages on stderr are not PowerShell errors
$ErrorActionPreference = 'Continue'
$script = Join-Path $PSScriptRoot '..\install.ps1'
$text = Get-Content -Raw $script
$host_ = (Get-Process -Id $PID).Path
$failed = 0

function Check($name, $ok) {
    if ($ok) { Write-Output "ok - $name" } else { Write-Output "not ok - $name"; $script:failed += 1 }
}

# the README's one-liner, with the text read from the file instead of the URL
function OneLiner {
    & ([scriptblock]::Create($text)) @args
}

Write-Output "PowerShell $($PSVersionTable.PSVersion) ($host_)"
$env:MGU_INSTALL_DOWNLOAD = $Base

OneLiner --help | Out-Null
Check 'one-liner: --help exits 0' ($LASTEXITCODE -eq 0)

OneLiner bogus 2>$null
Check 'one-liner: an unknown command exits 2' ($LASTEXITCODE -eq 2)

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('mgu-install-test-' + [guid]::NewGuid().ToString('N'))
$stick = Join-Path $tmp 'my stick'
$input_ = Join-Path $tmp 'repo with spaces'
New-Item -ItemType Directory -Path $stick, $input_ | Out-Null
Set-Content -Path (Join-Path $input_ 'catalog.json') -Value '{"schema":2,"components":[]}' -Encoding Ascii
OneLiner usb-repo "$stick\" "$input_\"
Check 'one-liner: arguments with spaces and a trailing backslash arrive whole' ($LASTEXITCODE -eq 0 -and
    (Test-Path (Join-Path $stick 'mgu-repo\repo-with-spaces\catalog.json')))

& $host_ -NoProfile -ExecutionPolicy Bypass -File $script bogus 2>$null
Check 'as a file: the exit status is mgu-install''s' ($LASTEXITCODE -eq 2)

$env:MGU_INSTALL_DOWNLOAD = $BadBase
OneLiner --help 2>$null | Out-Null
Check 'one-liner: a checksum mismatch runs nothing and sets 1' ($LASTEXITCODE -eq 1)
& $host_ -NoProfile -ExecutionPolicy Bypass -File $script --help 2>$null | Out-Null
Check 'as a file: a checksum mismatch exits 1' ($LASTEXITCODE -eq 1)

$env:MGU_INSTALL_DOWNLOAD = $Base
Remove-Item -Recurse -Force $tmp
$left = @(Get-ChildItem ([IO.Path]::GetTempPath()) -Filter 'mgu-install-*' -Directory | Where-Object { $_.Name -notlike 'mgu-install-test-*' })
@($left) + @($left | Get-ChildItem -Recurse) | ForEach-Object { Write-Output "left: $($_.FullName)" }
Check 'no download is left in the temp folder' ($left.Count -eq 0)

if ($failed) { Write-Output "$failed failed"; exit 1 }
Write-Output 'all passed'
exit 0
