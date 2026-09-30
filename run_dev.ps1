param([switch]$NoBrowser)
& "$PSScriptRoot\local_dev.ps1" -Action Start -NoBrowser:$NoBrowser
exit $LASTEXITCODE
