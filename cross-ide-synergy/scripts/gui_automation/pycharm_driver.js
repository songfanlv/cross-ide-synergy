const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const {
    ensureDir,
    killProcessTree,
    startProcess,
    waitForWindow,
    waitUntil,
} = require('./common');

class PyCharmDriver {
    constructor(options) {
        this.pycharmBat = options.pycharmBat;
        this.pluginZipPath = options.pluginZipPath;
        this.profileRoot = options.profileRoot;
        this.artifactDir = options.artifactDir;
        this.client = options.client;
        this.nativeDialogDriver = options.nativeDialogDriver;
        this.log = options.log || (() => {});
        this.process = null;
        this.mainWindow = null;
        this.mainSession = null;
        this.prepared = false;
    }

    async openProject(projectPath) {
        await this.prepareProfile();
        this.projectPath = projectPath;
        this.projectName = path.basename(projectPath);

        const env = {
            ...process.env,
            PYCHARM_PROPERTIES: this.propertiesPath,
        };

        this.log(`启动 PyCharm 隔离实例: ${this.projectName}`);
        this.process = startProcess(this.pycharmBat, [projectPath], {
            cwd: path.dirname(this.pycharmBat),
            env,
        });

        this.mainWindow = await waitUntil('PyCharm 主窗口', 120000, async () => {
            const mainWindow = await waitForWindow(
                { titlePattern: escapeRegexFragment(this.projectName) },
                3000
            ).catch(() => null);
            if (mainWindow) {
                return mainWindow;
            }
            await this.acceptTrustIfNeeded();
            return null;
        }, 1000);
        this.mainSession = await this.client.attachToWindow(this.mainWindow.MainWindowHandle);
        await this.capture('pycharm-opened.png');
        await this.waitForMenuReady();
    }

    async joinSession(shareCode) {
        await this.ensureMainSession();
        this.log(`PyCharm 打开 Join Session: ${shareCode}`);
        await this.clickMenuPath([
            ['Tools'],
            ['Cross-IDE Synergy'],
            ['Join Session', 'Join Cross-IDE Session'],
        ]);

        const desktopSession = await this.client.createDesktopSession();
        try {
            await waitUntil('Join Session 对话框输入框', 20000, async () => {
                const active = await desktopSession.getActiveElement().catch(() => null);
                return active || null;
            }, 500);
            await desktopSession.sendKeys(shareCode);
            const okButton = await this.findAnyElement(desktopSession, ['OK', 'Join'], 15000);
            await desktopSession.click(okButton);
        } finally {
            await desktopSession.delete().catch(() => {});
        }

        await this.capture('pycharm-join.png');
    }

    async disconnect() {
        await this.ensureMainSession();
        await this.clickMenuPath([
            ['Tools'],
            ['Cross-IDE Synergy'],
            ['Disconnect', 'Stop Session'],
        ]);
        await this.capture('pycharm-disconnect.png');
    }

    async editFile(relativeFilePath, marker) {
        const absolutePath = path.join(this.projectPath, relativeFilePath);
        const line = marker.endsWith('\n') ? marker : `${marker}\n`;
        fs.appendFileSync(absolutePath, line, 'utf8');
        const stats = fs.statSync(absolutePath);
        fs.utimesSync(absolutePath, stats.atime, new Date());
        this.log(`PyCharm 侧通过磁盘写入触发 VFS 监听: ${relativeFilePath}`);
    }

    async closeProject() {
        if (this.mainSession) {
            await this.mainSession.delete().catch(() => {});
        }
        if (this.mainWindow?.Id) {
            killProcessTree(this.mainWindow.Id);
        }
        this.mainSession = null;
        this.mainWindow = null;
    }

    async prepareProfile() {
        if (this.prepared) {
            return;
        }

        this.configDir = path.join(this.profileRoot, 'config');
        this.systemDir = path.join(this.profileRoot, 'system');
        this.pluginsDir = path.join(this.profileRoot, 'plugins');
        this.logDir = path.join(this.profileRoot, 'log');
        this.propertiesPath = path.join(this.profileRoot, 'idea.properties');

        ensureDir(this.configDir);
        ensureDir(this.systemDir);
        ensureDir(this.pluginsDir);
        ensureDir(this.logDir);

        const properties = [
            `idea.config.path=${normalizeIdeaPath(this.configDir)}`,
            `idea.system.path=${normalizeIdeaPath(this.systemDir)}`,
            `idea.plugins.path=${normalizeIdeaPath(this.pluginsDir)}`,
            `idea.log.path=${normalizeIdeaPath(this.logDir)}`,
            'ide.browser.jcef.headless.enabled=false',
            'ide.show.tips.on.startup.default.value=false',
        ].join('\n');
        fs.writeFileSync(this.propertiesPath, `${properties}\n`, 'ascii');

        this.log('安装 JetBrains 插件到隔离 profile');
        const zip = new AdmZip(this.pluginZipPath);
        zip.extractAllTo(this.pluginsDir, true);
        this.prepared = true;
    }

    async acceptTrustIfNeeded() {
        const trustAccepted = await this.nativeDialogDriver.acceptPyCharmTrustDialog(this.projectName);
        if (trustAccepted) {
            this.log('已接受 PyCharm 项目信任弹窗');
        }
    }

    async waitForMenuReady() {
        await this.ensureMainSession();
        await this.findAnyElement(this.mainSession, ['Tools'], 30000);
    }

    async clickMenuPath(levels) {
        await this.ensureMainSession();
        for (const names of levels) {
            const elementId = await this.findAnyElement(this.mainSession, names, 20000);
            await this.mainSession.click(elementId);
        }
    }

    async findAnyElement(session, names, timeoutMs, parentElementId = null) {
        return await waitUntil(`查找控件 ${names.join('/')}`, timeoutMs, async () => {
            for (const name of names) {
                const selectors = [
                    { using: 'name', value: name },
                    { using: 'xpath', value: `//*[contains(@Name, '${escapeXPathLiteral(name)}')]` },
                ];
                for (const selector of selectors) {
                    try {
                        return await session.findElement(selector.using, selector.value, parentElementId);
                    } catch {
                        // Try the next selector.
                    }
                }
            }
            return null;
        }, 500);
    }

    async capture(fileName) {
        if (!this.mainSession) {
            return;
        }
        await this.mainSession.screenshot(path.join(this.artifactDir, fileName)).catch(() => {});
    }

    async ensureMainSession() {
        if (!this.mainSession) {
            throw new Error('PyCharm 主窗口尚未连接。');
        }
    }
}

function normalizeIdeaPath(value) {
    return value.replace(/\\/g, '/');
}

function escapeRegexFragment(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeXPathLiteral(value) {
    return String(value).replace(/'/g, '');
}

module.exports = {
    PyCharmDriver,
};
