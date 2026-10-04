param([string]$Label = 'snapshot')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$backupRoot = Join-Path $projectRoot 'backups'
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$safeLabel = $Label -replace '[^a-zA-Z0-9_-]', '_'
$archivePath = Join-Path $backupRoot "$stamp-$safeLabel.zip"
$manifestPath = Join-Path $projectRoot 'asset-manifest.json'
$runtimeLogs = Join-Path $projectRoot 'automation\logs'
$files = @(Get-ChildItem -LiteralPath $projectRoot -Recurse -File | Where-Object {
    -not $_.FullName.StartsWith($backupRoot + [IO.Path]::DirectorySeparatorChar) -and
    -not $_.FullName.StartsWith($runtimeLogs + [IO.Path]::DirectorySeparatorChar) -and
    $_.FullName -ne $manifestPath -and
    $_.FullName -notmatch '[\\/]\.git[\\/]'
} | Sort-Object FullName)
$manifest = @($files | ForEach-Object {
    [ordered]@{
        path = $_.FullName.Substring($projectRoot.Length + 1)
        bytes = $_.Length
        modifiedUtc = $_.LastWriteTimeUtc.ToString('o')
        sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
})
ConvertTo-Json -InputObject $manifest -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in @($files) + @(Get-Item -LiteralPath $manifestPath)) {
        $relative = $file.FullName.Substring($projectRoot.Length + 1).Replace('\', '/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $relative, [IO.Compression.CompressionLevel]::Fastest) | Out-Null
    }
} finally { $zip.Dispose() }
$check = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    if ($check.Entries.Count -ne ($files.Count + 1)) { throw 'Archive entry count mismatch.' }
} finally { $check.Dispose() }
Write-Output "Saved: $archivePath"
Write-Output "Files: $($files.Count + 1)"
