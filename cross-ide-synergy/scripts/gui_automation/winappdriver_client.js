const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { waitUntil } = require('./common');
const { UiaAutomationClient } = require('./uia_client');

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

function getElementId(value) {
    if (!value) {
        return null;
    }
    return value[ELEMENT_KEY] || value.ELEMENT || null;
}

function findWinAppDriverExe() {
    const candidates = [
        process.env.WINAPPDRIVER_EXE,
        'D:\\Program Files\\winappdriver\\WinAppDriver.exe',
        'C:\\Program Files (x86)\\Windows Application Driver\\WinAppDriver.exe',
        'C:\\Program Files\\Windows Application Driver\\WinAppDriver.exe',
        path.resolve(__dirname, '..', '..', 'tmp', 'winappdriver', 'bin', 'WinAppDriver.exe'),
    ];
    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }

    const extractedRoot = path.resolve(__dirname, '..', '..', 'tmp', 'winappdriver', 'bin');
    if (!fs.existsSync(extractedRoot)) {
        return null;
    }

    const stack = [extractedRoot];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }
            if (entry.isFile() && entry.name === 'WinAppDriver.exe') {
                return fullPath;
            }
        }
    }

    return null;
}

class WinAppDriverClient {
    constructor(options = {}) {
        this.serverUrl = options.serverUrl || 'http://127.0.0.1:4723/wd/hub';
        this.log = options.log || (() => {});
        this.serverProcess = null;
        this.fallbackClient = new UiaAutomationClient({ log: this.log });
    }

    async ensureServer() {
        if (await this.isServerReady()) {
            return;
        }

        const exePath = findWinAppDriverExe();
        if (!exePath) {
            throw new Error('WinAppDriver 未安装。先运行系统安装脚本。');
        }

        this.log('启动 WinAppDriver');
        this.serverProcess = spawn(exePath, [], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            detached: true,
        });
        let output = '';
        this.serverProcess.stdout?.on('data', (chunk) => {
            output += chunk.toString();
        });
        this.serverProcess.stderr?.on('data', (chunk) => {
            output += chunk.toString();
        });
        this.serverProcess.unref();
        await waitUntil('WinAppDriver 服务', 20000, async () => {
            if (await this.isServerReady()) {
                return true;
            }
            if (this.serverProcess.exitCode !== null) {
                if (/Developer mode is not enabled/i.test(output)) {
                    throw new Error('WinAppDriver 无法启动：Windows Developer Mode 未开启。');
                }
                throw new Error(`WinAppDriver 进程提前退出。输出: ${sanitizeOutput(output)}`);
            }
            return null;
        }, 500);
    }

    async isServerReady() {
        try {
            const response = await fetch(`${this.serverUrl}/status`);
            return response.ok;
        } catch {
            return false;
        }
    }

    async createSession(capabilities) {
        try {
            await this.ensureServer();
        } catch (error) {
            if (shouldFallbackToUia(error)) {
                this.log(`WinAppDriver 不可用，切换为 UIAutomation 后备: ${error.message}`);
                return await this.fallbackClient.createSession(capabilities);
            }
            throw error;
        }
        const payload = {
            capabilities: { alwaysMatch: capabilities },
            desiredCapabilities: capabilities,
        };
        const response = await fetch(`${this.serverUrl}/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const json = await response.json();
        if (!response.ok) {
            throw new Error(json.value?.message || 'WinAppDriver session 创建失败。');
        }
        const sessionId = json.sessionId || json.value?.sessionId;
        if (!sessionId) {
            throw new Error('WinAppDriver 返回里缺少 sessionId。');
        }
        return new WinAppDriverSession(this, sessionId);
    }

    async createDesktopSession() {
        return await this.createSession({
            platformName: 'Windows',
            'appium:deviceName': 'WindowsPC',
            'appium:app': 'Root',
            app: 'Root',
            deviceName: 'WindowsPC',
        });
    }

    async attachToWindow(handle) {
        const hexHandle = Number(handle).toString(16);
        return await this.createSession({
            platformName: 'Windows',
            'appium:deviceName': 'WindowsPC',
            'appium:appTopLevelWindow': hexHandle,
            appTopLevelWindow: hexHandle,
            deviceName: 'WindowsPC',
        });
    }
}

function shouldFallbackToUia(error) {
    const message = String(error?.message || error || '');
    return (
        /Developer mode is not enabled/i.test(message) ||
        /WinAppDriver 未安装/i.test(message) ||
        /WinAppDriver 服务 timed out/i.test(message) ||
        /WinAppDriver 进程提前退出/i.test(message)
    );
}

function sanitizeOutput(value) {
    return String(value).replace(/\0/g, '').trim();
}

class WinAppDriverSession {
    constructor(client, sessionId) {
        this.client = client;
        this.sessionId = sessionId;
    }

    async delete() {
        await fetch(`${this.client.serverUrl}/session/${this.sessionId}`, { method: 'DELETE' }).catch(() => {});
    }

    async request(method, route, body) {
        const response = await fetch(`${this.client.serverUrl}/session/${this.sessionId}${route}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(json.value?.message || `WinAppDriver 请求失败: ${method} ${route}`);
        }
        return json.value;
    }

    async findElement(using, value, parentElementId = null) {
        const route = parentElementId ? `/element/${parentElementId}/element` : '/element';
        const result = await this.request('POST', route, { using, value });
        const elementId = getElementId(result);
        if (!elementId) {
            throw new Error(`WinAppDriver 没有返回元素 ID: ${using}=${value}`);
        }
        return elementId;
    }

    async click(elementId) {
        await this.request('POST', `/element/${elementId}/click`, {});
    }

    async clear(elementId) {
        await this.request('POST', `/element/${elementId}/clear`, {});
    }

    async setValue(elementId, text) {
        const chars = Array.from(String(text));
        await this.request('POST', `/element/${elementId}/value`, {
            text: String(text),
            value: chars,
        });
    }

    async sendKeys(text) {
        const chars = Array.from(String(text));
        await this.request('POST', '/keys', {
            text: String(text),
            value: chars,
        });
    }

    async getActiveElement() {
        const result = await this.request('POST', '/element/active', {});
        const elementId = getElementId(result);
        if (!elementId) {
            throw new Error('WinAppDriver 没有返回活动元素。');
        }
        return elementId;
    }

    async getAttribute(elementId, name) {
        return await this.request('GET', `/element/${elementId}/attribute/${encodeURIComponent(name)}`);
    }

    async screenshot(filePath) {
        const value = await this.request('GET', '/screenshot');
        fs.writeFileSync(filePath, Buffer.from(value, 'base64'));
    }
}

module.exports = {
    WinAppDriverClient,
    findWinAppDriverExe,
};
