const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const {
    findAvailablePort,
    findLatestFile,
    killProcessTree,
    startProcess,
    waitForHttpJson,
    waitForWindow,
    waitUntil,
} = require('./common');

class AntigravityDriver {
    constructor(options) {
        this.cliPath = options.cliPath;
        this.artifactDir = options.artifactDir;
        this.log = options.log || (() => {});
        this.client = options.client || null;
        this.browser = null;
        this.page = null;
        this.windowSession = null;
        this.windowInfo = null;
        this.launchProcess = null;
        this.logPath = null;
        this.logSinceMs = 0;
    }

    async openWorkspace(projectPath, mainFilePath) {
        this.projectPath = projectPath;
        this.mainFilePath = mainFilePath;
        this.remoteDebugPort = await findAvailablePort();
        this.logSinceMs = Date.now();

        const args = [
            `--remote-debugging-port=${this.remoteDebugPort}`,
            '--force-renderer-accessibility',
            '--new-window',
            projectPath,
            mainFilePath,
        ];

        try {
            this.log(`Antigravity 启动中，优先尝试 CDP 端口 ${this.remoteDebugPort}`);
            this.launchProcess = startProcess(this.cliPath, args, { cwd: path.dirname(this.cliPath) });
            await waitForHttpJson(`http://127.0.0.1:${this.remoteDebugPort}/json/version`, 20000);

            this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.remoteDebugPort}`);
            this.page = await waitUntil('Antigravity 工作台页面', 45000, async () => {
                for (const context of this.browser.contexts()) {
                    for (const page of context.pages()) {
                        const title = await page.title().catch(() => '');
                        const url = page.url();
                        if (
                            title.includes(path.basename(projectPath)) ||
                            title.includes('Antigravity') ||
                            url.startsWith('vscode-file://') ||
                            url.startsWith('file://')
                        ) {
                            return page;
                        }
                    }
                }
                return null;
            }, 1000);
        } catch (error) {
            this.log(`CDP 附着失败，切换为 WinAppDriver UIA 后备: ${error.message}`);
            await this.disposeLaunchedProcesses();
            if (!this.client) {
                throw error;
            }
            this.launchProcess = startProcess(this.cliPath, [
                '--force-renderer-accessibility',
                '--new-window',
                projectPath,
                mainFilePath,
            ], {
                cwd: path.dirname(this.cliPath),
            });
            this.windowInfo = await waitForWindow(
                { processName: 'Antigravity' },
                60000
            );
            this.windowSession = await this.client.attachToWindow(this.windowInfo.MainWindowHandle);
        }

        if (this.page) {
            await this.page.bringToFront();
            await this.page.waitForLoadState('domcontentloaded').catch(() => {});
        }
        this.logPath = await this.waitForLogFile();
        await this.waitForLog(/Commands registered/);
        await this.waitForLog(/Connected to agent/);
        await this.capture('antigravity-opened.png');
    }

    async clickShare() {
        if (!this.page && this.windowSession) {
            const elementId = await this.findAnyWindowElement([
                'Share',
                'Host',
                'Share Project',
                '分享',
            ]);
            await this.windowSession.click(elementId);
            return;
        }

        await this.ensurePage();
        await this.page.bringToFront();

        const statusSelectors = [
            'footer.part.statusbar a[aria-label*="Share"]',
            '.part.statusbar .statusbar-item[aria-label*="Share"]',
            '[aria-label*="Share project as host"]',
            'footer .statusbar-item:has-text("Share")',
            'footer .statusbar-item:has-text("分享")',
        ];

        for (const selector of statusSelectors) {
            const locator = this.page.locator(selector).first();
            const count = await locator.count().catch(() => 0);
            if (count === 0) {
                continue;
            }
            try {
                await locator.click({ timeout: 4000 });
                return;
            } catch {
                // Continue to the next DOM selector.
            }
        }

        await this.openCommandPalette();
        await this.selectCommand(/Cross-IDE:.*(Share|分享)/i);
    }

    async getShareCode() {
        const match = await this.waitForLog(/Session ready with share code ([A-Z0-9]{6})/);
        await this.capture('cross-ide-share.png');
        return match[1];
    }

    async editFile(_filePath, marker) {
        if (!this.page && this.windowSession) {
            await this.windowSession.sendKeys('^{END}');
            await this.windowSession.sendKeys('~');
            await this.windowSession.sendKeys(escapeSendKeysLiteral(marker));
            await this.windowSession.sendKeys('^s');
            return;
        }

        await this.ensurePage();
        const editor = this.page.locator('.monaco-editor textarea.inputarea').first();
        await editor.waitFor({ state: 'attached', timeout: 20000 });
        await editor.click();
        await this.page.keyboard.press('Control+End');
        await this.page.keyboard.press('Enter');
        await this.page.keyboard.type(marker, { delay: 20 });
        await this.page.keyboard.press('Control+S');
        await this.capture('antigravity-edit.png');
    }

    async disconnect() {
        if (!this.page && this.windowSession) {
            const elementId = await this.findAnyWindowElement([
                'Disconnect',
                'Stop Session',
                '断开',
            ]);
            await this.windowSession.click(elementId);
            return;
        }

        await this.ensurePage();
        await this.openCommandPalette();
        await this.selectCommand(/Cross-IDE:.*(Disconnect|断开)/i);
    }

    async waitForGuestLeft() {
        await this.waitForLog(/Guest left:/);
    }

    async waitForLog(pattern, timeoutMs = 45000) {
        const logPath = await this.waitForLogFile();
        return await waitUntil(`Antigravity 日志 ${pattern}`, timeoutMs, async () => {
            const content = fs.readFileSync(logPath, 'utf8');
            return content.match(pattern);
        }, 1000);
    }

    async waitForLogFile() {
        if (this.logPath && fs.existsSync(this.logPath)) {
            return this.logPath;
        }

        const logRoot = path.join(process.env.APPDATA, 'Antigravity', 'logs');
        this.logPath = await waitUntil('Cross-IDE Synergy 日志文件', 45000, async () => {
            const recent = findLatestFile(
                logRoot,
                (filePath) => filePath.endsWith('-Cross-IDE Synergy.log'),
                this.logSinceMs - 2000
            );
            if (recent) {
                return recent;
            }
            return findLatestFile(
                logRoot,
                (filePath) => filePath.endsWith('-Cross-IDE Synergy.log'),
                0
            );
        }, 1000);
        return this.logPath;
    }

    async openCommandPalette() {
        await this.ensurePage();
        await this.page.bringToFront();
        await this.page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P');
        const input = this.page.locator('.quick-input-widget input').first();
        await input.waitFor({ state: 'visible', timeout: 10000 });
        await input.fill('>Cross-IDE:');
    }

    async selectCommand(pattern) {
        const rows = this.page.locator('.quick-input-widget .monaco-list-row');
        await rows.first().waitFor({ state: 'visible', timeout: 10000 });
        const count = await rows.count();
        for (let index = 0; index < count; index++) {
            const row = rows.nth(index);
            const text = await row.innerText().catch(() => '');
            if (pattern.test(text)) {
                await row.click({ timeout: 4000 });
                return;
            }
        }

        throw new Error(`Cross-IDE 命令未找到：${pattern}`);
    }

    async capture(fileName) {
        if (!this.page && this.windowSession) {
            await this.windowSession.screenshot(path.join(this.artifactDir, fileName)).catch(() => {});
            return;
        }
        if (!this.page) {
            return;
        }
        await this.page
            .screenshot({
                path: path.join(this.artifactDir, fileName),
                fullPage: true,
            })
            .catch(() => {});
    }

    async ensurePage() {
        if (!this.page && !this.windowSession) {
            throw new Error('Antigravity 页面尚未连接。');
        }
    }

    async dispose() {
        if (this.browser) {
            await this.browser.close().catch(() => {});
        }
        if (this.windowSession) {
            await this.windowSession.delete().catch(() => {});
        }
        await this.disposeLaunchedProcesses();
        this.browser = null;
        this.page = null;
        this.windowSession = null;
        this.windowInfo = null;
    }

    async disposeLaunchedProcesses() {
        if (this.launchProcess?.pid) {
            killProcessTree(this.launchProcess.pid);
        }
        this.launchProcess = null;
    }

    async findAnyWindowElement(names) {
        return await waitUntil(`Antigravity 控件 ${names.join('/')}`, 20000, async () => {
            for (const name of names) {
                const selectors = [
                    { using: 'name', value: name },
                    { using: 'xpath', value: `//*[contains(@Name, '${escapeXPathLiteral(name)}')]` },
                ];
                for (const selector of selectors) {
                    try {
                        return await this.windowSession.findElement(selector.using, selector.value);
                    } catch {
                        // Try the next selector.
                    }
                }
            }
            return null;
        }, 500);
    }
}

function escapeXPathLiteral(value) {
    return String(value).replace(/'/g, '');
}

function escapeSendKeysLiteral(value) {
    return String(value)
        .replace(/\{/g, '{{}')
        .replace(/\}/g, '{}}')
        .replace(/\+/g, '{+}')
        .replace(/\^/g, '{^}')
        .replace(/%/g, '{%}')
        .replace(/~/g, '{~}')
        .replace(/\(/g, '{(}')
        .replace(/\)/g, '{)}')
        .replace(/\[/g, '{[}')
        .replace(/\]/g, '{]}');
}

module.exports = {
    AntigravityDriver,
};
