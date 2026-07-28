$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $projectRoot "runtime"
$serviceFile = Join-Path $runtimeDirectory "services.json"

try {
    if (-not (Test-Path -LiteralPath $serviceFile)) {
        Write-Host "[番鉴] 没有找到由启动器管理的运行中服务。" -ForegroundColor Yellow
        exit 0
    }

    $serviceState = Get-Content -LiteralPath $serviceFile -Raw | ConvertFrom-Json
    if ($serviceState.project_root -ne $projectRoot) {
        throw "服务记录不属于当前项目，已拒绝停止。"
    }

    $stopped = 0
    $records = @($serviceState.processes) | Sort-Object process_id -Descending
    foreach ($record in $records) {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.process_id)" -ErrorAction SilentlyContinue
        if (-not $current) {
            continue
        }
        $listener = Get-NetTCPConnection `
            -LocalPort ([int]$record.port) `
            -State Listen `
            -ErrorAction SilentlyContinue |
            Where-Object {
                $_.OwningProcess -eq [int]$record.process_id
            } |
            Select-Object -First 1
        if (-not $listener) {
            continue
        }
        Stop-Process -Id $record.process_id -Force -ErrorAction Stop
        $stopped++
    }

    [PSCustomObject]@{
        project_root = $projectRoot
        stopped_at = (Get-Date).ToUniversalTime().ToString("O")
        processes = @()
    } |
        ConvertTo-Json -Depth 3 |
        Set-Content -LiteralPath $serviceFile -Encoding UTF8

    Write-Host "[番鉴] 已停止 $stopped 个本地服务进程。" -ForegroundColor Cyan
    exit 0
}
catch {
    Write-Host "[番鉴] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
