[CmdletBinding()]
param(
  [ValidateSet('start', 'install', 'check')]
  [string]$Mode = 'start'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# This launcher downloads an official Node archive, never a remote script.
# Everything is installed inside this extracted PromoBridge folder.
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $projectRoot '.runtime'
$nodeVersion = '24.19.0'
$applicationLock = $null
$browserJob = $null

function Write-Step([string]$Message) {
  Write-Host "`n$Message" -ForegroundColor Cyan
}

function Invoke-Npm([string[]]$Arguments) {
  & (Join-Path $script:nodeDirectory 'npm.cmd') @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "O comando npm $($Arguments -join ' ') falhou (codigo $LASTEXITCODE). Confira as mensagens acima."
  }
}

function Get-TextHash([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
}

function Get-BuildFingerprint {
  $inputs = @('package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.worker.json') |
    ForEach-Object { Join-Path $projectRoot $_ }
  foreach ($directory in @('apps', 'packages')) {
    $inputs += Get-ChildItem -LiteralPath (Join-Path $projectRoot $directory) -File -Recurse |
      Where-Object { $_.FullName.Substring($projectRoot.Length) -notmatch '[\\/](dist|node_modules)[\\/]' } |
      Select-Object -ExpandProperty FullName
  }
  $records = $inputs | Sort-Object -Unique | ForEach-Object {
    if (-not (Test-Path -LiteralPath $_ -PathType Leaf)) { throw "Arquivo ausente: $_. Extraia o ZIP completo antes de iniciar." }
    "$($_.Substring($projectRoot.Length)) $((Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash)"
  }
  return Get-TextHash ($records -join "`n")
}

function Test-RunningApp([int]$Port) {
  try {
    $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/v1/health" -TimeoutSec 2
    $body = $health.Content | ConvertFrom-Json
    return ($body.ok -eq $true -and [bool]$body.version)
  } catch { return $false }
}

function Test-PortOpen([int]$Port) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $task = $client.ConnectAsync('127.0.0.1', $Port)
    return ($task.Wait(750) -and $client.Connected)
  } catch { return $false }
  finally { $client.Dispose() }
}

try {
  Set-Location -LiteralPath $projectRoot
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'package-lock.json'))) {
    throw 'Extraia o ZIP completo em uma pasta. Nao execute o aplicativo de dentro do arquivo compactado.'
  }

  $port = 3030
  if ($env:PROMOBRIDGE_PORT) {
    if (-not [int]::TryParse($env:PROMOBRIDGE_PORT, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
      throw 'PROMOBRIDGE_PORT precisa ser um numero entre 1 e 65535.'
    }
  }
  $panelUrl = "http://localhost:$port"
  if ($Mode -eq 'start' -and (Test-RunningApp $port)) {
    Write-Host 'O PromoBridge ja esta aberto. Abrindo seu painel...'
    Start-Process $panelUrl
    exit 0
  }
  if ($Mode -eq 'start' -and (Test-PortOpen $port)) {
    throw "Outro programa esta usando a porta $port. Feche esse programa e abra o PromoBridge novamente."
  }

  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  try {
    $applicationLock = [IO.File]::Open((Join-Path $runtimeRoot 'launcher.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch {
    throw 'Outra janela esta preparando ou executando esta copia do PromoBridge. Use a janela que ja esta aberta.'
  }

  $machineArchitecture = $env:PROCESSOR_ARCHITEW6432
  if (-not $machineArchitecture) { $machineArchitecture = $env:PROCESSOR_ARCHITECTURE }
  $architecture = switch ($machineArchitecture.ToUpperInvariant()) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { throw 'Esta versao precisa do Windows 64 bits (x64 ou ARM64).' }
  }
  $archiveName = "node-v$nodeVersion-win-$architecture.zip"
  $nodeDirectory = Join-Path $runtimeRoot "node-v$nodeVersion-win-$architecture"
  $nodeExecutable = Join-Path $nodeDirectory 'node.exe'
  $verifiedMarker = Join-Path $nodeDirectory '.verified-archive'
  if (-not (Test-Path -LiteralPath $nodeExecutable) -or -not (Test-Path -LiteralPath $verifiedMarker)) {
    Write-Step "1/3 - Preparando Node.js $nodeVersion para este aplicativo..."
    $downloadDirectory = Join-Path $runtimeRoot 'downloads'
    New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
    $archivePath = Join-Path $downloadDirectory $archiveName
    $checksumsPath = Join-Path $downloadDirectory 'SHASUMS256.txt'
    $downloadBase = "https://nodejs.org/download/release/v$nodeVersion"
    Invoke-WebRequest -UseBasicParsing -Uri "$downloadBase/SHASUMS256.txt" -OutFile $checksumsPath -TimeoutSec 180
    $checksumPattern = '^([a-fA-F0-9]{64})\s+\*?' + [Regex]::Escape($archiveName) + '$'
    $checksumLines = @(Get-Content -LiteralPath $checksumsPath | Where-Object { $_ -match $checksumPattern })
    if ($checksumLines.Count -ne 1 -or $checksumLines[0] -notmatch $checksumPattern) {
      throw 'O site oficial nao forneceu uma verificacao unica para o Node.js. O download foi interrompido.'
    }
    $expectedHash = [Regex]::Match($checksumLines[0], $checksumPattern).Groups[1].Value
    Invoke-WebRequest -UseBasicParsing -Uri "$downloadBase/$archiveName" -OutFile $archivePath -TimeoutSec 300
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ine $expectedHash) {
      Remove-Item -LiteralPath $archivePath -Force
      throw 'O arquivo recebido nao passou pela verificacao SHA-256. Confira sua conexao e tente novamente.'
    }
    if (Test-Path -LiteralPath $nodeDirectory) { Remove-Item -LiteralPath $nodeDirectory -Recurse -Force }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $runtimeRoot -Force
    if (-not (Test-Path -LiteralPath $nodeExecutable)) { throw 'O Node.js nao foi extraido corretamente. Verifique o antivirus e o espaco livre.' }
    Set-Content -LiteralPath $verifiedMarker -Value $expectedHash -Encoding Ascii
    Remove-Item -LiteralPath $archivePath -Force
  }
  & $nodeExecutable -e "if (process.versions.node !== '$nodeVersion') process.exit(1)"
  if ($LASTEXITCODE -ne 0) { throw 'A versao local do Node.js esta incorreta. Apague somente a pasta .runtime e abra o aplicativo novamente.' }
  $env:PATH = "$nodeDirectory;$env:PATH"

  $preparationPath = Join-Path $runtimeRoot 'prepared.json'
  $prepared = @{ dependencies = ''; build = '' }
  if (Test-Path -LiteralPath $preparationPath) {
    try {
      $previous = Get-Content -LiteralPath $preparationPath -Raw | ConvertFrom-Json
      $prepared.dependencies = [string]$previous.dependencies
      $prepared.build = [string]$previous.build
    } catch { $prepared = @{ dependencies = ''; build = '' } }
  }
  $dependencyHash = Get-TextHash ("$nodeVersion-$architecture`n" + (Get-FileHash -LiteralPath (Join-Path $projectRoot 'package-lock.json') -Algorithm SHA256).Hash)
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules')) -or $prepared.dependencies -ne $dependencyHash) {
    Write-Step '2/3 - Instalando os componentes. Na primeira vez pode demorar alguns minutos...'
    Invoke-Npm -Arguments @('ci', '--include=dev', '--no-audit', '--no-fund')
    $prepared.dependencies = $dependencyHash
    $prepared.build = ''
    $prepared | ConvertTo-Json | Set-Content -LiteralPath $preparationPath -Encoding Ascii
  }

  $buildHash = Get-BuildFingerprint
  $webBuild = Join-Path $projectRoot 'apps/web/dist/index.html'
  $workerBuild = Join-Path $projectRoot 'dist/worker/apps/worker/src/index.js'
  if ($Mode -eq 'check') {
    Write-Step '3/3 - Verificando o aplicativo...'
    Invoke-Npm -Arguments @('run', 'check')
    $prepared.build = $buildHash
  } elseif ($prepared.build -ne $buildHash -or -not (Test-Path -LiteralPath $webBuild) -or -not (Test-Path -LiteralPath $workerBuild)) {
    Write-Step '3/3 - Preparando o painel e o aplicativo...'
    Invoke-Npm -Arguments @('run', 'build')
    $prepared.build = $buildHash
  }
  $prepared | ConvertTo-Json | Set-Content -LiteralPath $preparationPath -Encoding Ascii
  if ($Mode -eq 'install' -or $Mode -eq 'check') {
    Write-Host "`nPronto! Abra INICIAR-PROMOBRIDGE.bat para usar o painel." -ForegroundColor Green
    exit 0
  }

  Write-Host "`nPromoBridge - mantenha esta janela aberta enquanto estiver usando." -ForegroundColor Green
  Write-Host "Seu painel: $panelUrl"
  Write-Host 'Para encerrar, pressione Ctrl+C nesta janela.'
  $browserJob = Start-Job -ArgumentList $panelUrl, $port -ScriptBlock {
    param($Url, $Port)
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      try {
        $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/v1/health" -TimeoutSec 1
        if (($health.Content | ConvertFrom-Json).ok) { Start-Process $Url; return }
      } catch { }
      Start-Sleep -Milliseconds 500
    }
  }
  & $nodeExecutable (Join-Path $projectRoot 'dist/worker/apps/worker/src/index.js')
  if ($LASTEXITCODE -ne 0) { throw "O aplicativo encerrou com codigo $LASTEXITCODE. Confira a mensagem acima." }
} catch {
  Write-Host "`nNao foi possivel concluir: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Se a internet caiu, reconecte e abra este arquivo novamente. Seus dados da pasta data sao preservados.'
  exit 1
} finally {
  if ($null -ne $browserJob) { Stop-Job $browserJob -ErrorAction SilentlyContinue; Remove-Job $browserJob -Force -ErrorAction SilentlyContinue }
  if ($null -ne $applicationLock) { $applicationLock.Dispose() }
}
