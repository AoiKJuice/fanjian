param(
    [switch]$NoDeploy,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot ".venv\Scripts\python.exe"
$runtime = Join-Path $projectRoot "runtime"
$statePath = Join-Path $runtime "retrain-expanded-state.json"
$baseModel = Join-Path $projectRoot "data\processed\anime-model-open-2026-27"
$mapping = Join-Path $baseModel "bangumi-mapping.parquet"
$bahamutOutput = Join-Path $projectRoot "data\processed\bahamut-2026"
$bahamutRatings = Join-Path $bahamutOutput "bahamut-user-ratings.parquet"
$combinedInput = Join-Path $projectRoot "data\processed\multisource-training-input"
$newModel = Join-Path $projectRoot "data\processed\anime-model-multisource-2026"
$backupModel = Join-Path $projectRoot "data\processed\anime-model-user-animelist-20260727"

Set-Location -LiteralPath $projectRoot
New-Item -ItemType Directory -Path $runtime -Force | Out-Null

function Write-State {
    param(
        [string]$Stage,
        [string]$Status,
        [string]$Message = ""
    )
    [PSCustomObject]@{
        process_id = $PID
        updated_at = (Get-Date).ToUniversalTime().ToString("O")
        stage = $Stage
        status = $Status
        message = $Message
    } |
        ConvertTo-Json |
        Set-Content -LiteralPath $statePath -Encoding UTF8
    Write-Host "[retrain] $Stage - $Status $Message"
}

function Invoke-Python {
    param([string[]]$Arguments)
    & $python @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Python command failed with exit code $LASTEXITCODE`: $($Arguments -join ' ')"
    }
}

try {
    if (-not (Test-Path -LiteralPath $python)) {
        throw "Python environment is missing: $python"
    }
    if (-not (Test-Path -LiteralPath $mapping)) {
        throw "Bangumi/Bahamut mapping is missing: $mapping"
    }

    Write-State "bahamut_download" "running"
    if (-not (Test-Path -LiteralPath (Join-Path $bahamutOutput "manifest.json"))) {
        Invoke-Python @(
            "-m", "backend.training.download_bahamut_ratings",
            "--mapping", $mapping,
            "--output", $bahamutOutput,
            "--checkpoint", (Join-Path $projectRoot "data\raw\bahamut-2026\checkpoint"),
            "--salt", (Join-Path $projectRoot "data\raw\bahamut-2026\private\user-hash-salt.bin"),
            "--request-interval", "0.5",
            "--max-pages-per-item", "5000"
        )
    }

    Write-State "combine_sources" "running"
    if (-not (Test-Path -LiteralPath (Join-Path $combinedInput "manifest.json"))) {
        Invoke-Python @(
            "-m", "backend.training.prepare_combined_training",
            "--base-artifact", $baseModel,
            "--supplemental-ratings", $bahamutRatings,
            "--output", $combinedInput,
            "--source-name", "Bahamut ACG public per-user ratings",
            "--license-note", "Local non-commercial research; no redistribution"
        )
    }

    Write-State "build_index" "running"
    if (-not (Test-Path -LiteralPath (Join-Path $newModel "manifest.json"))) {
        Invoke-Python @(
            "-m", "backend.training.build_artifacts",
            (Join-Path $combinedInput "combined-ratings.parquet"),
            (Join-Path $combinedInput "catalog-source.csv"),
            "--output", $newModel,
            "--min-user-ratings", "20",
            "--min-user-stddev", "0.5",
            "--min-score-bins", "3",
            "--min-item-ratings", "20",
            "--batch-size", "250000",
            "--source-url", "User Animelist Dataset + Bahamut ACG public ratings",
            "--license-note", "User Animelist CC BY 4.0; Bahamut local non-commercial research only",
            "--data-version", "user-animelist-v1+bahamut-2026+catalog-30308"
        )
    }

    $knnSearch = Join-Path $newModel "knn-search.json"
    Write-State "knn_parameter_search" "running"
    if (-not (Test-Path -LiteralPath $knnSearch)) {
        Invoke-Python @(
            "-m", "backend.training.search_knn",
            $newModel,
            "--output", $knnSearch,
            "--users", "100",
            "--seed", "20260730"
        )
    }
    $knn = Get-Content -LiteralPath $knnSearch -Raw | ConvertFrom-Json
    $selected = $knn.selected

    $mixSearch = Join-Path $newModel "surprise-mix-search.json"
    Write-State "surprise_mix_search" "running"
    if (-not (Test-Path -LiteralPath $mixSearch)) {
        Invoke-Python @(
            "-m", "backend.training.search_surprise_mix",
            $newModel,
            "--output", $mixSearch,
            "--users", "100",
            "--seed", "20260730",
            "--overlap-min", "$($selected.overlap_min)",
            "--shrinkage", "$($selected.shrinkage)",
            "--neighbor-count", "$($selected.neighbor_count)",
            "--uncertainty-penalty", "$($selected.uncertainty_penalty)",
            "--min-support", "$($selected.min_support)"
        )
    }
    $mix = Get-Content -LiteralPath $mixSearch -Raw | ConvertFrom-Json

    $evaluation = Join-Path $newModel "evaluation-500.json"
    Write-State "final_evaluation" "running"
    if (-not (Test-Path -LiteralPath $evaluation)) {
        Invoke-Python @(
            "-m", "backend.training.evaluation",
            $newModel,
            "--output", $evaluation,
            "--users", "500",
            "--seed", "20260731",
            "--overlap-min", "$($selected.overlap_min)",
            "--shrinkage", "$($selected.shrinkage)",
            "--neighbor-count", "$($selected.neighbor_count)",
            "--surprise-mix", "$($mix.selected.surprise_mix)",
            "--uncertainty-penalty", "$($selected.uncertainty_penalty)",
            "--min-support", "$($selected.min_support)"
        )
    }

    $selection = Join-Path $newModel "model-selection.json"
    Write-State "model_selection" "running"
    Invoke-Python @(
        "-m", "backend.training.select_model",
        $evaluation,
        "--output", $selection
    )
    $production = Get-Content -LiteralPath $selection -Raw | ConvertFrom-Json

    Write-State "affinity_calibration" "running"
    Invoke-Python @(
        "-m", "backend.training.calibrate_affinity",
        $newModel,
        "--users", "500",
        "--seed", "20260801",
        "--candidates-per-user", "100",
        "--overlap-min", "$($production.parameters.overlap_min)",
        "--shrinkage", "$($production.parameters.shrinkage)",
        "--neighbor-count", "$($production.parameters.neighbor_count)",
        "--uncertainty-penalty", "$($production.parameters.uncertainty_penalty)",
        "--min-support", "$($production.parameters.min_support)",
        "--similarity-mode", "$($production.production_similarity_mode)",
        "--surprise-mix", "$($production.parameters.surprise_mix)"
    )

    if ($NoDeploy) {
        Write-State "complete_not_deployed" "complete" $newModel
        exit 0
    }

    Write-State "deploy" "running"
    & (Join-Path $PSScriptRoot "stop.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to stop local services."
    }
    if (Test-Path -LiteralPath $backupModel) {
        throw "Model backup directory already exists: $backupModel"
    }
    Move-Item -LiteralPath $baseModel -Destination $backupModel
    try {
        Move-Item -LiteralPath $newModel -Destination $baseModel
    }
    catch {
        Move-Item -LiteralPath $backupModel -Destination $baseModel
        throw
    }
    if ($NoBrowser) {
        & (Join-Path $PSScriptRoot "launch.ps1") -NoBrowser
    }
    else {
        & (Join-Path $PSScriptRoot "launch.ps1")
    }
    if ($LASTEXITCODE -ne 0) {
        throw "The multisource model was deployed, but app startup failed."
    }
    Write-State "complete" "complete" "Multisource model deployed"
}
catch {
    Write-State "failed" "failed" $_.Exception.Message
    throw
}
