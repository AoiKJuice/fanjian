param(
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
if ($env:ANIME_NO_BROWSER -eq "1") {
    $NoBrowser = $true
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $projectRoot "runtime"
$serviceFile = Join-Path $runtimeDirectory "services.json"
$buildStamp = Join-Path $runtimeDirectory "web-build.stamp"
$launcherLog = Join-Path $runtimeDirectory "launcher.log"
$webUrl = "http://127.0.0.1:3000"
$browserUrl = "http://localhost:3000"
$apiHealthUrl = "http://127.0.0.1:8000/api/v1/health"
$startedProcesses = [System.Collections.Generic.List[int]]::new()
$startedPorts = [System.Collections.Generic.List[int]]::new()

Set-Location -LiteralPath $projectRoot
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
Set-Content -LiteralPath $launcherLog -Value "" -Encoding UTF8
$modelDirectory = Join-Path $projectRoot "data\processed\anime-model-open-2026-27"
$modelManifest = Join-Path $modelDirectory "manifest.json"
$env:ANIME_MODEL_PATH = $modelDirectory

function Write-Step {
    param([string]$Message)
    Write-Host "[番鉴] $Message" -ForegroundColor Cyan
    Add-Content -LiteralPath $launcherLog `
        -Value "$((Get-Date).ToString('HH:mm:ss.fff')) $Message" `
        -Encoding UTF8
}

function Test-HttpEndpoint {
    param(
        [string]$Url,
        [string]$RequiredText = ""
    )
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -ne 200) {
            return $false
        }
        if ($RequiredText -and $response.Content -notlike "*$RequiredText*") {
            return $false
        }
        return $true
    }
    catch {
        return $false
    }
}

function Wait-ForEndpoint {
    param(
        [string]$Url,
        [string]$Name,
        [string]$RequiredText = "",
        [int]$Attempts = 80
    )
    for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
        if (Test-HttpEndpoint -Url $Url -RequiredText $RequiredText) {
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw "$Name 未能在预期时间内启动。"
}

function Assert-PortAvailable {
    param(
        [int]$Port,
        [string]$ServiceName
    )
    $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listeners) {
        throw "端口 $Port 已被其他程序占用，无法启动$ServiceName。"
    }
}

function Wait-ForPort {
    param(
        [int]$Port,
        [string]$Name,
        [int]$Attempts = 80
    )
    for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
        $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($listener) {
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw "$Name 未能在预期时间内启动。"
}

function Invoke-Checked {
    param(
        [string]$Command,
        [string[]]$Arguments,
        [string]$FailureMessage
    )
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw $FailureMessage
    }
}

function Install-RecommendationModel {
    param([string]$PythonExecutable)

    $releaseManifestPath = Join-Path $projectRoot "scripts\model-release.json"
    if (-not (Test-Path -LiteralPath $releaseManifestPath -PathType Leaf)) {
        throw "模型下载清单不存在：$releaseManifestPath"
    }
    $releaseManifest = Get-Content -LiteralPath $releaseManifestPath -Raw -Encoding UTF8 |
        ConvertFrom-Json
    $downloadDirectory = Join-Path $runtimeDirectory "model-download\$($releaseManifest.release_tag)"
    New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
    foreach ($part in @($releaseManifest.parts)) {
        $partPath = Join-Path $downloadDirectory $part.name
        $validPart = $false
        if (Test-Path -LiteralPath $partPath -PathType Leaf) {
            $actualHash = (Get-FileHash -LiteralPath $partPath -Algorithm SHA256).Hash.ToLowerInvariant()
            $validPart =
                (Get-Item -LiteralPath $partPath).Length -eq [int64]$part.bytes -and
                $actualHash -eq ([string]$part.sha256).ToLowerInvariant()
        }
        if ($validPart) {
            Write-Step "使用已校验的模型分卷 $($part.name)"
            continue
        }
        if (Test-Path -LiteralPath $partPath) {
            Remove-Item -LiteralPath $partPath -Force
        }
        $partialPath = "$partPath.partial"
        if (Test-Path -LiteralPath $partialPath) {
            Remove-Item -LiteralPath $partialPath -Force
        }
        $downloadUrls = [System.Collections.Generic.List[string]]::new()
        if ($env:FANJIAN_MODEL_MIRROR) {
            $downloadUrls.Add(
                "$($env:FANJIAN_MODEL_MIRROR.TrimEnd('/'))/$($part.name)"
            )
        }
        $downloadUrls.Add([string]$part.url)
        $downloaded = $false
        foreach ($downloadUrl in $downloadUrls) {
            try {
                Write-Step "下载模型分卷 $($part.name)"
                Invoke-WebRequest `
                    -Uri $downloadUrl `
                    -OutFile $partialPath `
                    -UseBasicParsing `
                    -TimeoutSec 7200
                $actualHash = (
                    Get-FileHash -LiteralPath $partialPath -Algorithm SHA256
                ).Hash.ToLowerInvariant()
                if (
                    (Get-Item -LiteralPath $partialPath).Length -ne [int64]$part.bytes -or
                    $actualHash -ne ([string]$part.sha256).ToLowerInvariant()
                ) {
                    throw "下载文件校验失败"
                }
                Move-Item -LiteralPath $partialPath -Destination $partPath
                $downloaded = $true
                break
            }
            catch {
                if (Test-Path -LiteralPath $partialPath) {
                    Remove-Item -LiteralPath $partialPath -Force
                }
                Add-Content -LiteralPath $launcherLog `
                    -Value "模型下载失败 $downloadUrl $($_.Exception.Message)" `
                    -Encoding UTF8
            }
        }
        if (-not $downloaded) {
            throw "模型分卷下载失败：$($part.name)"
        }
    }
    Write-Step "校验并安装本地推荐模型"
    Invoke-Checked -Command $PythonExecutable `
        -Arguments @(
            "scripts\install_model.py",
            $releaseManifestPath,
            $downloadDirectory,
            (Join-Path $projectRoot "data\processed")
        ) `
        -FailureMessage "模型安装或 SHA-256 校验失败。"
}

function Get-ListenerProcessRecords {
    param([int[]]$Ports)

    $records = foreach ($port in $Ports) {
        $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $listener) {
            continue
        }
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
        [PSCustomObject]@{
            process_id = [int]$process.ProcessId
            creation_date = $process.CreationDate.ToUniversalTime().ToString("O")
            name = $process.Name
            port = $port
        }
    }
    return @($records | Sort-Object process_id -Unique)
}

try {
    if (Test-Path -LiteralPath $serviceFile -PathType Leaf) {
        $previous = Get-Content -LiteralPath $serviceFile -Raw -Encoding UTF8 |
            ConvertFrom-Json
        if ($previous.project_root -eq $projectRoot) {
            Write-Step "停止该项目上次启动的服务"
            foreach ($record in @($previous.processes)) {
                $process = Get-CimInstance Win32_Process `
                    -Filter "ProcessId = $($record.process_id)" `
                    -ErrorAction SilentlyContinue
                if (-not $process) {
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
                if ($listener) {
                    Stop-Process -Id $record.process_id -Force
                }
            }
            Start-Sleep -Milliseconds 500
            Remove-Item -LiteralPath $serviceFile -Force
        }
    }

    $npmCommand = Get-Command "npm.cmd" -ErrorAction Stop
    $nodeCommand = Get-Command "node.exe" -ErrorAction Stop
    $nodeVersion = (& $nodeCommand.Source --version).TrimStart("v")
    if ([version]$nodeVersion -lt [version]"22.13.0") {
        throw "需要 Node.js 22.13.0 或更高版本，当前版本为 $nodeVersion。"
    }

    $virtualPython = Join-Path $projectRoot ".venv\Scripts\python.exe"
    if (-not (Test-Path -LiteralPath $virtualPython)) {
        Write-Step "首次运行：创建 Python 3.12 环境"
        $pythonLauncher = Get-Command "py.exe" -ErrorAction SilentlyContinue
        if ($pythonLauncher) {
            Invoke-Checked -Command $pythonLauncher.Source `
                -Arguments @("-3.12", "-m", "venv", ".venv") `
                -FailureMessage "无法通过 py.exe 创建 Python 3.12 环境。"
        }
        else {
            $pythonCommand = Get-Command "python.exe" -ErrorAction Stop
            $pythonVersion = (& $pythonCommand.Source -c "import sys; print('.'.join(map(str, sys.version_info[:2])))").Trim()
            if ($pythonVersion -ne "3.12") {
                throw "需要 Python 3.12，当前版本为 $pythonVersion。"
            }
            Invoke-Checked -Command $pythonCommand.Source `
                -Arguments @("-m", "venv", ".venv") `
                -FailureMessage "Python 虚拟环境创建失败。"
        }
    }

    & $virtualPython -c "import fastapi, polars, duckdb, scipy, numba, zstandard" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Step "首次运行：安装 Python 依赖"
        Invoke-Checked -Command $virtualPython `
            -Arguments @("-m", "pip", "install", "-e", ".") `
            -FailureMessage "Python 依赖安装失败。"
    }

    if (-not (Test-Path -LiteralPath $modelManifest -PathType Leaf)) {
        Write-Step "首次运行：准备完整推荐模型"
        Install-RecommendationModel -PythonExecutable $virtualPython
    }
    if (-not (Test-Path -LiteralPath $modelManifest -PathType Leaf)) {
        throw "没有找到真实模型：$modelManifest"
    }

    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "node_modules"))) {
        Write-Step "首次运行：安装 Web 依赖"
        Invoke-Checked -Command $npmCommand.Source `
            -Arguments @("ci") `
            -FailureMessage "Web 依赖安装失败。"
    }

    $buildInputs = @(
        (Join-Path $projectRoot "app"),
        (Join-Path $projectRoot "public"),
        (Join-Path $projectRoot "package.json"),
        (Join-Path $projectRoot "package-lock.json"),
        (Join-Path $projectRoot "next.config.ts"),
        (Join-Path $projectRoot "vite.config.ts")
    )
    $latestSourceTime = (
        $buildInputs |
            ForEach-Object {
                if (Test-Path -LiteralPath $_ -PathType Container) {
                    Get-ChildItem -LiteralPath $_ -Recurse -File
                }
                elseif (Test-Path -LiteralPath $_ -PathType Leaf) {
                    Get-Item -LiteralPath $_
                }
            } |
            Measure-Object -Property LastWriteTimeUtc -Maximum
    ).Maximum
    $buildOutput = Join-Path $projectRoot "dist\server\index.js"
    $requiresBuild =
        -not (Test-Path -LiteralPath $buildOutput) -or
        -not (Test-Path -LiteralPath $buildStamp) -or
        (Get-Item -LiteralPath $buildStamp).LastWriteTimeUtc -lt $latestSourceTime

    if ($requiresBuild) {
        Write-Step "生成本地 Web 构建"
        Invoke-Checked -Command $npmCommand.Source `
            -Arguments @("run", "build") `
            -FailureMessage "Web 构建失败。"
        Set-Content -LiteralPath $buildStamp -Value (Get-Date).ToUniversalTime().ToString("O") -Encoding UTF8
    }

    if (-not (Test-HttpEndpoint -Url $apiHealthUrl -RequiredText '"status":"ok"')) {
        Assert-PortAvailable -Port 8000 -ServiceName " API"
        Write-Step "启动本地推荐 API"
        $apiProcess = Start-Process `
            -FilePath $virtualPython `
            -ArgumentList @("-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1", "--port", "8000") `
            -WorkingDirectory $projectRoot `
            -RedirectStandardOutput (Join-Path $runtimeDirectory "api.stdout.log") `
            -RedirectStandardError (Join-Path $runtimeDirectory "api.stderr.log") `
            -WindowStyle Hidden `
            -PassThru
        $startedProcesses.Add($apiProcess.Id)
        Wait-ForEndpoint -Url $apiHealthUrl -Name "推荐 API" -RequiredText '"status":"ok"'
        $startedPorts.Add(8000)
    }

    if (-not (Test-HttpEndpoint -Url "$webUrl/dashboard" -RequiredText "anime-affinity-lab")) {
        Assert-PortAvailable -Port 3000 -ServiceName " Web 服务"
        Assert-PortAvailable -Port 3001 -ServiceName " Web 内部服务"
        Write-Step "启动本地 Web 界面"
        $webProcess = Start-Process `
            -FilePath $npmCommand.Source `
            -ArgumentList @("run", "start") `
            -WorkingDirectory $projectRoot `
            -RedirectStandardOutput (Join-Path $runtimeDirectory "web.stdout.log") `
            -RedirectStandardError (Join-Path $runtimeDirectory "web.stderr.log") `
            -WindowStyle Hidden `
            -PassThru
        $startedProcesses.Add($webProcess.Id)
        Wait-ForPort -Port 3000 -Name "Web 界面"
        Start-Sleep -Seconds 1
        $startedPorts.Add(3000)
        $startedPorts.Add(3001)
    }

    if ($startedPorts.Count -gt 0) {
        Write-Step "记录本次启动的服务"
        Start-Sleep -Milliseconds 500
        $records = Get-ListenerProcessRecords -Ports ([int[]]$startedPorts)
        [PSCustomObject]@{
            project_root = $projectRoot
            started_at = (Get-Date).ToUniversalTime().ToString("O")
            processes = $records
        } |
            ConvertTo-Json -Depth 4 |
            Set-Content -LiteralPath $serviceFile -Encoding UTF8
        Write-Step "服务记录已保存"
    }

    if (-not $NoBrowser) {
        Write-Step "服务已就绪，正在打开浏览器"
        Start-Process $browserUrl
    }
    else {
        Write-Step "服务已就绪"
    }
    Write-Host "关闭浏览器不会停止服务。需要停止时双击“停止番鉴.cmd”。" -ForegroundColor DarkGray
    exit 0
}
catch {
    if ($startedPorts.Count -gt 0) {
        $records = Get-ListenerProcessRecords -Ports ([int[]]$startedPorts)
        foreach ($record in $records) {
            Stop-Process -Id $record.process_id -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Host "[番鉴] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "日志目录：$runtimeDirectory" -ForegroundColor DarkGray
    exit 1
}
