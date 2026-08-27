#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"
$genFarmerExe = "C:\Users\Joel\AppData\Local\Programs\GenFarmer\GenFarmer.exe"

$rules = Get-NetFirewallApplicationFilter -Program $genFarmerExe |
  Get-NetFirewallRule |
  Where-Object { $_.Direction -eq "Inbound" -and $_.Action -eq "Allow" }

if (-not $rules) {
  Write-Host "No active inbound allow rules were found for GenFarmer."
} else {
  $rules | Disable-NetFirewallRule
  Write-Host "Disabled $($rules.Count) inbound GenFarmer firewall rule(s)."
}

$response = Invoke-WebRequest -Uri "http://127.0.0.1:55554/" -UseBasicParsing -TimeoutSec 20
Write-Host "Local GenFarmer check: HTTP $($response.StatusCode) - $($response.Content)"
