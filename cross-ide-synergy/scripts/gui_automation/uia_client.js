const {
    escapePowerShellSingleQuotes,
    runPowerShell,
} = require('./common');

class UiaAutomationClient {
    constructor(options = {}) {
        this.log = options.log || (() => {});
    }

    async createSession(capabilities) {
        const app = capabilities['appium:app'] || capabilities.app;
        const handleHex = capabilities['appium:appTopLevelWindow'] || capabilities.appTopLevelWindow;
        if (app === 'Root') {
            return new UiaSession({ rootType: 'desktop', log: this.log });
        }
        if (handleHex) {
            return new UiaSession({
                rootType: 'window',
                handle: parseInt(String(handleHex), 16),
                log: this.log,
            });
        }
        throw new Error('UIAutomation 后备不支持当前 session capabilities。');
    }

    async createDesktopSession() {
        return await this.createSession({ app: 'Root' });
    }

    async attachToWindow(handle) {
        return await this.createSession({ appTopLevelWindow: Number(handle).toString(16) });
    }
}

class UiaSession {
    constructor(options) {
        this.rootType = options.rootType;
        this.handle = options.handle || 0;
        this.log = options.log || (() => {});
    }

    async delete() {
        return;
    }

    async findElement(using, value, _parentElementId = null) {
        const selector = normalizeSelector(using, value);
        const script = [
            buildPrelude(),
            `$element = Resolve-Element '${this.rootType}' ${this.handle} '${escapePowerShellSingleQuotes(selector)}'`,
            'if ($null -eq $element) { return }',
            `$result = [pscustomobject]@{ token = '${escapePowerShellSingleQuotes(
                Buffer.from(JSON.stringify({ rootType: this.rootType, handle: this.handle, selector })).toString('base64')
            )}' }`,
            '$result | ConvertTo-Json -Compress',
        ].join("`n");
        const { stdout } = await runPowerShell(script);
        const trimmed = stdout.trim();
        if (!trimmed) {
            throw new Error(`UIAutomation 未找到控件: ${using}=${value}`);
        }
        return JSON.parse(trimmed).token;
    }

    async click(elementId) {
        const token = decodeToken(elementId);
        const script = [
            buildPrelude(true),
            `$element = Resolve-Element '${token.rootType}' ${token.handle} '${escapePowerShellSingleQuotes(token.selector)}'`,
            'if ($null -eq $element) { throw "Element not found for click." }',
            '$pattern = $null',
            'if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {',
            '    ([System.Windows.Automation.InvokePattern]$pattern).Invoke()',
            '    return',
            '}',
            '$pattern = $null',
            'if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {',
            '    ([System.Windows.Automation.SelectionItemPattern]$pattern).Select()',
            '    return',
            '}',
            '$point = $element.GetClickablePoint()',
            '[UiaWin32]::SetCursorPos([int]$point.X, [int]$point.Y) | Out-Null',
            'Start-Sleep -Milliseconds 120',
            '[UiaWin32]::mouse_event([UiaWin32]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)',
            'Start-Sleep -Milliseconds 60',
            '[UiaWin32]::mouse_event([UiaWin32]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)',
        ].join("`n");
        await runPowerShell(script);
    }

    async clear(_elementId) {
        return;
    }

    async setValue(elementId, text) {
        const token = decodeToken(elementId);
        const escapedText = escapePowerShellSingleQuotes(String(text));
        const script = [
            buildPrelude(),
            `$element = Resolve-Element '${token.rootType}' ${token.handle} '${escapePowerShellSingleQuotes(token.selector)}'`,
            'if ($null -eq $element) { throw "Element not found for setValue." }',
            '$pattern = $null',
            'if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {',
            `    ([System.Windows.Automation.ValuePattern]$pattern).SetValue('${escapedText}')`,
            '} else {',
            '    throw "Element does not support ValuePattern."',
            '}',
        ].join("`n");
        await runPowerShell(script);
    }

    async sendKeys(text) {
        const escapedKeys = escapePowerShellSingleQuotes(String(text));
        const script = [
            buildPrelude(),
            `Focus-Root '${this.rootType}' ${this.handle}`,
            '$shell = New-Object -ComObject WScript.Shell',
            `Start-Sleep -Milliseconds 150`,
            `$shell.SendKeys('${escapedKeys}')`,
        ].join("`n");
        await runPowerShell(script);
    }

    async getActiveElement() {
        const selector = '__active__';
        return Buffer.from(JSON.stringify({
            rootType: this.rootType,
            handle: this.handle,
            selector,
        })).toString('base64');
    }

    async getAttribute(_elementId, _name) {
        return null;
    }

    async screenshot(filePath) {
        const escapedFile = escapePowerShellSingleQuotes(filePath);
        const script = [
            buildPrelude(true),
            `Capture-Root '${this.rootType}' ${this.handle} '${escapedFile}'`,
        ].join("`n");
        await runPowerShell(script);
    }
}

function normalizeSelector(using, value) {
    if (using === 'name') {
        return `name:${value}`;
    }
    if (using === 'xpath') {
        const containsMatch = String(value).match(/contains\(@Name,\s*'([^']+)'\)/i);
        if (containsMatch) {
            return `contains:${containsMatch[1]}`;
        }
        const equalsMatch = String(value).match(/@Name='([^']+)'/i);
        if (equalsMatch) {
            return `name:${equalsMatch[1]}`;
        }
    }
    throw new Error(`UIAutomation 后备暂不支持选择器: ${using}=${value}`);
}

function decodeToken(elementId) {
    return JSON.parse(Buffer.from(String(elementId), 'base64').toString('utf8'));
}

function buildPrelude() {
    const lines = [
        'Add-Type -AssemblyName UIAutomationClient',
        'Add-Type -AssemblyName UIAutomationTypes',
        'Add-Type -AssemblyName System.Drawing',
        'Add-Type -AssemblyName System.Windows.Forms',
    ];
    lines.push(
        "@'",
        'using System;',
        'using System.Runtime.InteropServices;',
        'public static class UiaWin32 {',
        '  [StructLayout(LayoutKind.Sequential)]',
        '  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
        '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
        '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
        '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);',
        '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
        '  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);',
        '  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;',
        '  public const uint MOUSEEVENTF_LEFTUP = 0x0004;',
        '}',
        "'@ | Add-Type"
    );

    lines.push(
        'function Get-Root([string]$rootType, [int]$handle) {',
        "  if ($rootType -eq 'desktop') { return [System.Windows.Automation.AutomationElement]::RootElement }",
        '  return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$handle)',
        '}',
        'function Resolve-Element([string]$rootType, [int]$handle, [string]$selector) {',
        '  $root = Get-Root $rootType $handle',
        '  if ($null -eq $root) { return $null }',
        "  if ($selector -eq '__active__') { return [System.Windows.Automation.AutomationElement]::FocusedElement }",
        "  if ($selector.StartsWith('name:')) {",
        '    $target = $selector.Substring(5)',
        '    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $target)',
        '    return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)',
        '  }',
        "  if ($selector.StartsWith('contains:')) {",
        '    $target = $selector.Substring(9)',
        '    $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)',
        '    foreach ($element in $elements) {',
        '      if ($element.Current.Name -like \"*$target*\") { return $element }',
        '    }',
        '  }',
        '  return $null',
        '}',
        'function Focus-Root([string]$rootType, [int]$handle) {',
        "  if ($rootType -ne 'window' -or $handle -le 0) { return }",
        '  [UiaWin32]::ShowWindow([IntPtr]$handle, 5) | Out-Null',
        '  Start-Sleep -Milliseconds 120',
        '  [UiaWin32]::SetForegroundWindow([IntPtr]$handle) | Out-Null',
        '}',
        'function Capture-Root([string]$rootType, [int]$handle, [string]$filePath) {',
        "  if ($rootType -eq 'window' -and $handle -gt 0) {",
        '    $rect = New-Object UiaWin32+RECT',
        '    [UiaWin32]::GetWindowRect([IntPtr]$handle, [ref]$rect) | Out-Null',
        '    $width = [Math]::Max(1, $rect.Right - $rect.Left)',
        '    $height = [Math]::Max(1, $rect.Bottom - $rect.Top)',
        '    $bitmap = New-Object System.Drawing.Bitmap $width, $height',
        '    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
        '    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)',
        '    $bitmap.Save($filePath, [System.Drawing.Imaging.ImageFormat]::Png)',
        '    $graphics.Dispose()',
        '    $bitmap.Dispose()',
        '    return',
        '  }',
        '  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
        '  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
        '  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
        '  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)',
        '  $bitmap.Save($filePath, [System.Drawing.Imaging.ImageFormat]::Png)',
        '  $graphics.Dispose()',
        '  $bitmap.Dispose()',
        '}'
    );

    return lines.join("`n");
}

module.exports = {
    UiaAutomationClient,
};
