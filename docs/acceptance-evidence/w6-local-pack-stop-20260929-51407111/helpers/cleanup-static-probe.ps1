. (Join-Path $PSScriptRoot 'W6.Isolated.Common.ps1')
$lock = Read-SourceLock
$probe = 'D:\autocut\video-auto-cut-w6-51407111-4c6fb40ff737\VideoAutoCut\tools\material_gen\records\_probe_w6.txt'
$records = 'D:\autocut\video-auto-cut-w6-51407111-4c6fb40ff737\VideoAutoCut\tools\material_gen\records'
Remove-OwnedProbe $lock $probe $probe 'ba9c736f19e7f60b7f6764adb0b7908c0a2b394e09b6c09863528c7f2bc86095' | Out-Null
Remove-OwnedEmptyDirectory $lock $records $records $true
Assert-IsolatedWorktree $lock 'after-static-probe-confirmation'
