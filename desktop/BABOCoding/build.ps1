$ErrorActionPreference = 'Stop'

$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path $compiler)) {
    throw 'The Windows .NET Framework C# compiler was not found.'
}

$outputDirectory = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$output = Join-Path $outputDirectory 'BABO-CODING.exe'
$arguments = @(
    '/nologo',
    '/target:winexe',
    ('/out:' + $output),
    '/reference:System.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll',
    (Join-Path $PSScriptRoot 'Program.cs'),
    (Join-Path $PSScriptRoot 'SimulationService.cs')
)

& $compiler @arguments
if ($LASTEXITCODE -ne 0) {
    throw 'BABO CODING compilation failed.'
}

Write-Output ('Built ' + $output)
