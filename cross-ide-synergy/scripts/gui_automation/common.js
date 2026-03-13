const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFile, spawnSync } = require('child_process');

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(label, timeoutMs, fn, intervalMs = 500) {
    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < timeoutMs) {
        try {
            const value = await fn();
            if (value) {
                return value;
            }
        } catch (error) {
            lastError = error;
        }
        await delay(intervalMs);
    }

    const suffix = lastError ? ` Last error: ${lastError.message}` : '';
    throw new Error(`${label} timed out after ${Math.ceil(timeoutMs / 1000)} seconds.${suffix}`);
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function ensureCleanDir(dirPath) {
    fs.rmSync(dirPath, { recursive: true, force: true });
    fs.mkdirSync(dirPath, { recursive: true });
}

async function findAvailablePort(host = '127.0.0.1') {
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once('error', reject);
        server.listen(0, host, () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => reject(new Error('Unable to allocate port.')));
                return;
            }

            const { port } = address;
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(port);
            });
        });
    });
}

function runProcess(filePath, args, options = {}) {
    const child = spawn(filePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...options,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
    });

    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => {
            resolve({ code: code ?? 0, stdout, stderr });
        });
    });
}

function startProcess(filePath, args, options = {}) {
    const child = spawn(filePath, args, {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: false,
        shell: process.platform === 'win32' && path.extname(filePath).toLowerCase() === '.cmd',
        ...options,
    });
    return child;
}

function killProcessTree(pid) {
    if (!pid) {
        return;
    }

    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
        });
        return;
    }

    try {
        process.kill(-pid, 'SIGKILL');
    } catch {
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            // Ignore cleanup failures.
        }
    }
}

function escapePowerShellSingleQuotes(value) {
    return String(value).replace(/'/g, "''");
}

function runPowerShell(script) {
    return new Promise((resolve, reject) => {
        execFile(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
            { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
            (error, stdout, stderr) => {
                if (error) {
                    error.stdout = stdout;
                    error.stderr = stderr;
                    reject(error);
                    return;
                }
                resolve({ stdout, stderr });
            }
        );
    });
}

async function runPowerShellJson(script) {
    const { stdout } = await runPowerShell(script);
    const trimmed = stdout.trim();
    if (!trimmed) {
        return null;
    }
    return JSON.parse(trimmed);
}

function listFilesRecursive(rootDir) {
    const results = [];
    if (!fs.existsSync(rootDir)) {
        return results;
    }

    const stack = [rootDir];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = `${current}\\${entry.name}`;
            if (entry.isDirectory()) {
                stack.push(fullPath);
            } else {
                results.push(fullPath);
            }
        }
    }

    return results;
}

function copyRecursive(sourcePath, targetPath) {
    const stats = fs.statSync(sourcePath);
    if (stats.isDirectory()) {
        fs.mkdirSync(targetPath, { recursive: true });
        for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
            copyRecursive(
                path.join(sourcePath, entry.name),
                path.join(targetPath, entry.name)
            );
        }
        return;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
}

function findLatestFile(rootDir, predicate, sinceTimeMs = 0) {
    let latestPath = null;
    let latestMtime = sinceTimeMs;
    for (const filePath of listFilesRecursive(rootDir)) {
        const stats = fs.statSync(filePath);
        if (stats.mtimeMs < sinceTimeMs) {
            continue;
        }
        if (!predicate(filePath)) {
            continue;
        }
        if (stats.mtimeMs >= latestMtime) {
            latestPath = filePath;
            latestMtime = stats.mtimeMs;
        }
    }
    return latestPath;
}

async function waitForHttpJson(url, timeoutMs) {
    return await waitUntil(`HTTP endpoint ${url}`, timeoutMs, async () => {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                return null;
            }
            return await response.json();
        } catch {
            return null;
        }
    }, 500);
}

async function getTopLevelWindows(filter = {}) {
    const clauses = ['$_.MainWindowHandle -ne 0'];
    if (filter.processName) {
        clauses.push(`$_.ProcessName -eq '${escapePowerShellSingleQuotes(filter.processName)}'`);
    }
    if (filter.titlePattern) {
        clauses.push(`$_.MainWindowTitle -match '${escapePowerShellSingleQuotes(filter.titlePattern)}'`);
    }

    const script = [
        `$items = Get-Process | Where-Object { ${clauses.join(' -and ')} } | Select-Object Id, ProcessName, MainWindowHandle, MainWindowTitle, StartTime`,
        '$items | ConvertTo-Json -Depth 3',
    ].join('; ');

    const value = await runPowerShellJson(script);
    if (!value) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

async function waitForWindow(filter, timeoutMs, sortDescending = true) {
    return await waitUntil(`Window ${filter.processName || ''} ${filter.titlePattern || ''}`.trim(), timeoutMs, async () => {
        const windows = await getTopLevelWindows(filter);
        if (windows.length === 0) {
            return null;
        }
        const sorted = windows.sort((left, right) => {
            const a = new Date(left.StartTime).getTime();
            const b = new Date(right.StartTime).getTime();
            return sortDescending ? b - a : a - b;
        });
        return sorted[0];
    }, 1000);
}

module.exports = {
    copyRecursive,
    delay,
    ensureCleanDir,
    ensureDir,
    escapePowerShellSingleQuotes,
    findAvailablePort,
    findLatestFile,
    getTopLevelWindows,
    killProcessTree,
    listFilesRecursive,
    runPowerShell,
    runPowerShellJson,
    runProcess,
    startProcess,
    waitForHttpJson,
    waitForWindow,
    waitUntil,
};
