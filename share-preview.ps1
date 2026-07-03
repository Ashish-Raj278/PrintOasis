$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
$npx = (Get-Command npx.cmd -ErrorAction Stop).Source
$port = if ($env:PORT) { $env:PORT } else { "3000" }

Write-Host ""
Write-Host "Starting PrintOasis client preview..." -ForegroundColor Cyan
Write-Host "Keep this window open while your client reviews the website." -ForegroundColor Yellow
Write-Host ""

$server = Start-Process `
  -FilePath $node `
  -ArgumentList "server.js" `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -PassThru

try {
  Start-Sleep -Seconds 2
  if ($server.HasExited) {
    throw "The website server could not start. Port $port may already be in use."
  }

  $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/" -TimeoutSec 10
  if ($response.StatusCode -ne 200) {
    throw "The website did not respond correctly."
  }

  Write-Host "Website is ready. Creating a secure public link..." -ForegroundColor Green
  Write-Host "The first run may take a minute while the tunnel utility downloads." -ForegroundColor DarkGray
  Write-Host ""

  & $npx --yes localtunnel --port $port
}
finally {
  if ($server -and -not $server.HasExited) {
    Stop-Process -Id $server.Id -Force
  }
  Write-Host ""
  Write-Host "Client preview stopped. The public link is no longer active." -ForegroundColor Yellow
}
