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
$testExecutable = Join-Path $outputDirectory 'BABO-CODING.Tests.exe'
$arguments = @(
    '/nologo',
    '/target:exe',
    ('/out:' + $testExecutable),
    '/reference:System.dll',
    (Join-Path $PSScriptRoot 'SimulationService.cs'),
    (Join-Path $PSScriptRoot 'SimulationServiceTests.cs')
)

& $compiler @arguments
if ($LASTEXITCODE -ne 0) {
    throw 'Simulation tests did not compile.'
}

& $testExecutable
if ($LASTEXITCODE -ne 0) {
    throw 'Simulation tests failed.'
}
