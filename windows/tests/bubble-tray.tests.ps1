$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $root 'scripts/common-windows.ps1')
. (Join-Path $root 'scripts/localization-windows.ps1')
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $root 'scripts/tray-dream-skin.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
foreach ($name in @('Add-DreamSkinTrayItem', 'Invoke-DreamSkinTrayBubbleCommand', 'Add-DreamSkinTrayBubbleMenu')) {
  $definition = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  }, $true)
  if (-not $definition) { throw "Missing bubble tray function: $name" }
  . ([scriptblock]::Create($definition.Extent.Text))
}

$SkillRoot = $root
$StateRoot = Join-Path ([IO.Path]::GetTempPath()) ('dreamskin-bubble-tray-' + [guid]::NewGuid().ToString('N'))
$paths = [pscustomobject]@{ Active = Join-Path $StateRoot 'active-theme' }
$menu = [System.Windows.Forms.ContextMenuStrip]::new()
$script:bubbleMode = 'theme'
$script:bubblePresetId = $null
$script:bubbleWarning = $false
$script:bubbleExit = 0
$script:bubbleError = $null
$script:bubbleCalls = @()
$script:runtimeCalls = 0
$script:lockDepth = 0
$priorEncoding = [Console]::OutputEncoding
function Get-DreamSkinNodeRuntime { $script:runtimeCalls++; return [pscustomobject]@{ Path = 'validated-node.exe' } }
function Resolve-DreamSkinLanguage { param($StateRoot) return 'en-US' }
function Get-DreamSkinTrayText { param($Key) return Get-DreamSkinText -Key $Key -Language 'en-US' }
function Show-DreamSkinTrayError { param($Message) $script:bubbleError = $Message }
function Invoke-DreamSkinTrayThemeOperation {
  param([scriptblock]$Action)
  $script:lockDepth++
  try { return & $Action } finally { $script:lockDepth-- }
}
function Invoke-DreamSkinNative {
  param($FilePath, [string[]]$ArgumentList, [switch]$SeparateStderr)
  if ($FilePath -cne 'validated-node.exe' -or -not $SeparateStderr -or $script:lockDepth -ne 1) {
    throw 'Bubble command bypassed the validated native path or operation lock.'
  }
  $script:bubbleCalls += ,$ArgumentList
  $preferencesIndex = [Array]::IndexOf($ArgumentList, '--preferences')
  if ($preferencesIndex -lt 0 -or $ArgumentList[$preferencesIndex + 1] -cne (Join-Path $StateRoot 'bubble-preferences.json')) {
    throw 'Bubble command did not use its separate preferences file.'
  }
  if ($script:bubbleExit -ne 0) {
    return [pscustomobject]@{ ExitCode = $script:bubbleExit; ErrorOutput = @('fixture-cli-failed'); Output = @() }
  }
  if ($ArgumentList[1] -ceq 'preset') { $script:bubbleMode = 'preset'; $script:bubblePresetId = $ArgumentList[2] }
  if ($ArgumentList[1] -ceq 'theme') { $script:bubbleMode = 'theme' }
  $warnings = @()
  if ($script:bubbleWarning) { $warnings = @('fixture-warning') }
  return [pscustomobject]@{
    ExitCode = 0; ErrorOutput = @(); Output = @((@{
      preferences = @{ schemaVersion = 1; mode = $script:bubbleMode; presetId = $script:bubblePresetId }
      presets = @(
        @{ id = 'one'; name = 'One'; nameEn = 'One' },
        @{ id = 'two'; name = 'Two'; nameEn = 'Two' }
      )
      warnings = $warnings
    } | ConvertTo-Json -Depth 6 -Compress))
  }
}

try {
  [void][IO.Directory]::CreateDirectory($paths.Active)
  [IO.File]::WriteAllText((Join-Path $paths.Active 'theme.json'), '{}')
  [IO.File]::WriteAllText((Join-Path $StateRoot 'theme-preferences.json'), 'global-transparency-fixture')
  Add-DreamSkinTrayBubbleMenu
  $bubble = $menu.Items[0]
  if (-not $bubble.DropDownItems[0].Checked -or $bubble.Text -cne 'Chat bubble colors') {
    throw 'Missing follow-theme default or separate submenu.'
  }
  # Choosing the first preset must not accidentally capture the last loop ID.
  $bubble.DropDownItems[2].PerformClick()
  if ($script:bubblePresetId -cne 'one') { throw 'Preset action captured the wrong ID.' }
  $menu.Items.Clear()
  Add-DreamSkinTrayBubbleMenu
  $bubble = $menu.Items[0]
  if ($bubble.DropDownItems[0].Checked -or -not $bubble.DropDownItems[2].Checked) { throw 'Selected preset checkmark is wrong.' }
  $bubble.DropDownItems[0].PerformClick()
  if ($script:bubbleMode -cne 'theme' -or $script:bubblePresetId -cne 'one') {
    throw 'Following theme did not preserve the independent preset snapshot.'
  }
  Invoke-DreamSkinTrayBubbleCommand -Arguments @('custom', '--foreground', '#C6D0F5', '--background', '#414559', '--transparency', '25.5', '--blur', '24')
  $lastCall = $script:bubbleCalls[-1]
  if ($lastCall[2] -cne '--foreground' -or $lastCall[3] -cne '#C6D0F5' -or $lastCall[7] -cne '25.5' -or $lastCall[9] -cne '24') {
    throw 'Custom fields were not forwarded unchanged to the shared validator.'
  }
  $script:bubblePresetId = $null
  $script:bubbleMode = 'preset'
  $menu.Items.Clear()
  Add-DreamSkinTrayBubbleMenu
  if (-not $menu.Items[0].DropDownItems[5].Checked) { throw 'Custom settings were not distinguished from built-in presets.' }
  $script:bubbleWarning = $true
  $menu.Items.Clear()
  Add-DreamSkinTrayBubbleMenu
  $menu.Items[0].DropDownItems[0].PerformClick()
  if ($script:bubbleError -cne 'fixture-warning') { throw 'Preference recovery warnings were hidden.' }
  $script:bubbleWarning = $false
  $script:bubbleExit = 3
  $rejected = $false
  try { Invoke-DreamSkinTrayBubbleCommand -Arguments @('theme') } catch { $rejected = $_.Exception.Message -like '*fixture-cli-failed*' }
  if (-not $rejected -or [Console]::OutputEncoding.CodePage -ne $priorEncoding.CodePage -or $script:lockDepth -ne 0) {
    throw 'CLI failure was not reported or caller encoding/lock was not restored.'
  }
  if ([IO.File]::ReadAllText((Join-Path $StateRoot 'theme-preferences.json')) -cne 'global-transparency-fixture') {
    throw 'Bubble settings modified the overall transparency file.'
  }
  if ($script:runtimeCalls -ne $script:bubbleCalls.Count) { throw 'A bubble command skipped runtime validation.' }
  Write-Output 'Bubble tray dispatch, independent preferences, preset closures, warnings and failure restoration passed.'
} finally {
  $menu.Dispose()
  if ([IO.Path]::GetFileName($StateRoot) -like 'dreamskin-bubble-tray-*') {
    Remove-Item -LiteralPath $StateRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
