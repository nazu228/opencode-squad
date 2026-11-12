#Requires -Version 5.1
param(
    [string]$ConfigDir = "",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$agentsSrc = Join-Path $repoRoot "agents"
$pluginSrc = Join-Path $repoRoot "plugins\squad"

if (-not (Test-Path (Join-Path $agentsSrc "team-lid.md"))) {
    throw "Не найден agents\team-lid.md. Запускайте скрипт из папки репозитория."
}
if (-not (Test-Path (Join-Path $pluginSrc "index.ts"))) {
    throw "Не найден plugins\squad\index.ts. Запускайте скрипт из папки репозитория."
}

function Get-OpenCodeConfigDir {
    if ($ConfigDir -ne "") {
        return [System.IO.Path]::GetFullPath($ConfigDir)
    }
    if ($env:OPENCODE_CONFIG_DIR) {
        return [System.IO.Path]::GetFullPath($env:OPENCODE_CONFIG_DIR)
    }
    if ($env:XDG_CONFIG_HOME) {
        return Join-Path $env:XDG_CONFIG_HOME "opencode"
    }
    return Join-Path $HOME ".config\opencode"
}

$config = Get-OpenCodeConfigDir
$agentsDst = Join-Path $config "agents"
$pluginDst = Join-Path $config "plugins\squad"
$pluginsDst = Join-Path $config "plugins"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $config ("squad-backup-" + $stamp)

Write-Host ""
Write-Host "OpenCode Squad installer"
Write-Host "  repo:   $repoRoot"
Write-Host "  config: $config"
if ($DryRun) {
    Write-Host "  mode:   dry run (файлы не изменяются)"
}
Write-Host ""

$agentFiles = Get-ChildItem (Join-Path $agentsSrc "*.md") -File
$needBackup = $false

foreach ($file in $agentFiles) {
    if (Test-Path (Join-Path $agentsDst $file.Name)) {
        $needBackup = $true
    }
}
if (Test-Path $pluginDst) {
    $needBackup = $true
}

if ($needBackup) {
    if ($DryRun) {
        Write-Host "Backup: будет создан $backup"
    }
    else {
        New-Item -ItemType Directory -Path (Join-Path $backup "agents") -Force | Out-Null
        foreach ($file in $agentFiles) {
            $target = Join-Path $agentsDst $file.Name
            if (Test-Path $target) {
                Copy-Item $target (Join-Path $backup "agents") -Force
            }
        }
        if (Test-Path $pluginDst) {
            New-Item -ItemType Directory -Path (Join-Path $backup "plugins") -Force | Out-Null
            Copy-Item $pluginDst (Join-Path $backup "plugins") -Recurse -Force
        }
        Write-Host "Backup: $backup"
    }
}
else {
    Write-Host "Backup: не требуется, существующих файлов squad нет"
}

if ($DryRun) {
    Write-Host ""
    Write-Host "Будет установлено:"
    Write-Host "  agents: $agentsDst ($($agentFiles.Count) файлов)"
    Write-Host "  plugin: $pluginDst"
    Write-Host ""
    Write-Host "Dry run завершён."
    exit 0
}

New-Item -ItemType Directory -Path $agentsDst -Force | Out-Null
New-Item -ItemType Directory -Path $pluginsDst -Force | Out-Null

Copy-Item (Join-Path $agentsSrc "*.md") $agentsDst -Force

if (Test-Path $pluginDst) {
    Remove-Item $pluginDst -Recurse -Force
}
Copy-Item $pluginSrc $pluginsDst -Recurse -Force

Write-Host ""
Write-Host "Готово. Установлено:"
Write-Host "  agents: $agentsDst ($($agentFiles.Count) файлов)"
Write-Host "  plugin: $pluginDst"
if ($needBackup) {
    Write-Host "  backup: $backup"
}
Write-Host ""
Write-Host "Дальше:"
Write-Host "  1. Перезапустите OpenCode или выполните: opencode reload"
Write-Host "  2. Проверьте: opencode plugin list; opencode debug agents"
Write-Host "  3. В корне проекта: /squad 4 <задача>"
Write-Host ""

if (-not (Get-Command opencode -ErrorAction SilentlyContinue)) {
    Write-Warning "opencode не найден в PATH. Установите OpenCode или добавьте его в PATH."
}
