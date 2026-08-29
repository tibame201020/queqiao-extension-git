param(
  [string]$QueqiaoCore = (Join-Path (Split-Path $PSScriptRoot -Parent) "..\Queqiao")
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$core = (Resolve-Path $QueqiaoCore).Path
$queqiao = Join-Path $core "dist\queqiao.js"
$runtimeRoot = Join-Path $env:TEMP ("queqiao-extension-git-acceptance-" + [guid]::NewGuid().ToString("N"))
$localAppData = Join-Path $runtimeRoot "LocalAppData"
$registryState = Join-Path $runtimeRoot "registry.json"
$registryProcess = $null
$tarballPath = $null

function Get-FreePort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return ([Net.IPEndPoint]$listener.LocalEndpoint).Port }
  finally { $listener.Stop() }
}

function Invoke-Queqiao([string[]]$Arguments) {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & node $queqiao @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($exitCode -ne 0) { throw "queqiao $($Arguments -join ' ') failed:`n$($output -join "`n")" }
  return ($output -join "`n")
}

function Invoke-Git([string]$WorkingDirectory, [string[]]$Arguments) {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & git -C $WorkingDirectory @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($exitCode -ne 0) { throw "git $($Arguments -join ' ') failed:`n$($output -join "`n")" }
}

$oldLocalAppData = $env:LOCALAPPDATA
$oldRegistry = $env:npm_config_registry
$oldCache = $env:npm_config_cache
$oldGateway = $env:QUEQIAO_E2E_GATEWAY
$oldApproval = $env:QUEQIAO_E2E_APPROVAL_FILE
$oldWorkspace = $env:QUEQIAO_E2E_WORKSPACE_ID
try {
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
  $env:LOCALAPPDATA = $localAppData
  $env:npm_config_cache = Join-Path $runtimeRoot "npm-cache"

  Push-Location $core
  try {
    if (!(Test-Path "node_modules")) {
      npm ci --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "Queqiao npm ci failed" }
    }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Queqiao workspace build failed" }
    npm run build:package
    if ($LASTEXITCODE -ne 0) { throw "Queqiao package build failed" }
  } finally { Pop-Location }

  Push-Location $repo
  try {
    if (!(Test-Path "node_modules\@modelcontextprotocol\client")) {
      npm ci --ignore-scripts --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "extension npm ci failed" }
    }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "extension build failed" }
    $tarball = (npm pack --ignore-scripts --silent | Select-Object -Last 1).Trim()
    if ($LASTEXITCODE -ne 0 -or !$tarball) { throw "extension npm pack failed" }
    $tarballPath = Join-Path $repo $tarball
  } finally { Pop-Location }

  $workerPort = Get-FreePort
  $gatewayPort = Get-FreePort
  $managementPort = Get-FreePort
  $registryProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList @(
    (Join-Path $repo "test-fixtures\npm-registry.mjs"),
    $tarballPath,
    $registryState
  ) -WorkingDirectory $repo -PassThru -WindowStyle Hidden
  for ($i = 0; $i -lt 100 -and !(Test-Path $registryState); $i++) { Start-Sleep -Milliseconds 100 }
  if (!(Test-Path $registryState)) { throw "Ephemeral npm registry did not start" }
  $registryInfo = Get-Content $registryState -Raw | ConvertFrom-Json
  $env:npm_config_registry = $registryInfo.registry

  $workspace = Join-Path $runtimeRoot "git-e2e-workspace"
  $repository = Join-Path $workspace "repo"
  New-Item -ItemType Directory -Force -Path $repository | Out-Null
  Invoke-Git $repository @("init")
  Invoke-Git $repository @("config", "user.email", "queqiao-release@example.invalid")
  Invoke-Git $repository @("config", "user.name", "Queqiao Release")
  [IO.File]::WriteAllText((Join-Path $repository "README.md"), "release acceptance`n", [Text.UTF8Encoding]::new($false))
  Invoke-Git $repository @("add", "README.md")
  Invoke-Git $repository @("commit", "-m", "release acceptance")

  Push-Location $core
  try {
    $bootstrap = & npx --no-install tsx (Join-Path $repo "test-fixtures\bootstrap-queqiao.mts") $core $workerPort $gatewayPort $managementPort $workspace
    if ($LASTEXITCODE -ne 0) { throw "Queqiao deterministic runtime bootstrap failed" }
  } finally { Pop-Location }
  $bootstrapInfo = $bootstrap | ConvertFrom-Json
  if ($bootstrapInfo.workspaceId -ne "git-e2e-workspace") { throw "Unexpected bootstrap Workspace id: $($bootstrapInfo.workspaceId)" }

  Invoke-Queqiao @("extension", "install", "npm:@tibame201020/queqiao-extension-git", "--worker", "git-e2e") | Out-Null

  Invoke-Queqiao @("worker", "serve", "--worker", "git-e2e", "--bg") | Out-Null
  $workerStatus = $null
  for ($i = 0; $i -lt 100; $i++) {
    try {
      $workerStatus = Invoke-Queqiao @("worker", "status", "--worker", "git-e2e", "--json") | ConvertFrom-Json
      if ($workerStatus.health.reachable -and $workerStatus.health.identityMatches) { break }
    } catch {}
    Start-Sleep -Milliseconds 100
  }
  if (!$workerStatus -or !$workerStatus.health.reachable -or !$workerStatus.health.identityMatches) { throw "Worker did not become ready" }

  Invoke-Queqiao @("gateway", "serve", "--gateway", "git-e2e-gateway", "--bg") | Out-Null
  $join = $null
  for ($i = 0; $i -lt 100 -and !$join; $i++) {
    try { $join = Invoke-Queqiao @("gateway", "join-token", "--gateway", "git-e2e-gateway", "--expires", "60", "--json") | ConvertFrom-Json }
    catch { Start-Sleep -Milliseconds 100 }
  }
  if (!$join -or !$join.joinCode) { throw "Gateway management endpoint did not return a join code" }
  Invoke-Queqiao @("worker", "join", "--worker", "git-e2e", "--join-code", $join.joinCode, "--json") | Out-Null

  $env:QUEQIAO_E2E_GATEWAY = "http://127.0.0.1:$gatewayPort/"
  $env:QUEQIAO_E2E_APPROVAL_FILE = Join-Path $localAppData "Queqiao\gateways\git-e2e-gateway\data\secrets\oauth-approval.secret"
  $env:QUEQIAO_E2E_WORKSPACE_ID = $bootstrapInfo.workspaceId
  $result = & node (Join-Path $repo "test-fixtures\gateway-git-client.mjs")
  if ($LASTEXITCODE -ne 0) { throw "Gateway Git MCP client failed" }
  $parsed = $result | ConvertFrom-Json
  if (!$parsed.ok -or $parsed.extensionId -ne "dev.queqiao.git" -or $parsed.publicTool -ne "extension" -or $parsed.capability -ne "git_status") {
    throw "Unexpected Git acceptance result: $result"
  }
  Write-Output $result
} finally {
  try { if (Test-Path $queqiao) { Invoke-Queqiao @("worker", "stop", "--worker", "git-e2e") | Out-Null } } catch {}
  try { if (Test-Path $queqiao) { Invoke-Queqiao @("gateway", "stop", "--gateway", "git-e2e-gateway") | Out-Null } } catch {}
  if ($registryProcess -and !$registryProcess.HasExited) { Stop-Process -Id $registryProcess.Id -Force -ErrorAction SilentlyContinue }
  if ($tarballPath) { Remove-Item $tarballPath -Force -ErrorAction SilentlyContinue }
  Remove-Item $runtimeRoot -Recurse -Force -ErrorAction SilentlyContinue
  $env:LOCALAPPDATA = $oldLocalAppData
  $env:npm_config_registry = $oldRegistry
  $env:npm_config_cache = $oldCache
  $env:QUEQIAO_E2E_GATEWAY = $oldGateway
  $env:QUEQIAO_E2E_APPROVAL_FILE = $oldApproval
  $env:QUEQIAO_E2E_WORKSPACE_ID = $oldWorkspace
}
