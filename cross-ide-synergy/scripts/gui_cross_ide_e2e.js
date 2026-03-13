const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    copyRecursive,
    ensureCleanDir,
    ensureDir,
    findLatestFile,
    waitUntil,
} = require('./gui_automation/common');
const { AntigravityDriver } = require('./gui_automation/antigravity_driver');
const { NativeDialogDriver } = require('./gui_automation/native_dialog_driver');
const { PyCharmDriver } = require('./gui_automation/pycharm_driver');
const { WinAppDriverClient, findWinAppDriverExe } = require('./gui_automation/winappdriver_client');

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }

    const repoRoot = path.resolve(__dirname, '..');
    const runId = createRunId();
    const runRoot = path.join(repoRoot, 'tmp', 'gui-control-e2e', runId);
    const artifactDir = path.join(runRoot, 'artifacts');
    const logFile = path.join(runRoot, 'gui-control-e2e.log');

    ensureCleanDir(runRoot);
    ensureDir(artifactDir);

    const log = createLogger(logFile);
    const heartbeat = startHeartbeat(log, options.heartbeatMs);

    try {
        log(`运行目录: ${runRoot}`);
        const antigravityExe = resolveAntigravityExecutable(options.antigravityCli);
        const pycharmBat = resolvePyCharmBat(options.pycharmBat);
        const cockpitLauncher = resolveCockpitLauncher(options.cockpitLauncher);
        const installedExtensionPath = resolveInstalledAntigravityExtension(repoRoot, options.installedExtensionPath);
        const jetbrainsZip = resolveExistingFile(
            options.jetbrainsZip || path.join(repoRoot, 'release', 'jetbrains', 'cross-ide-synergy-v3.0.0.zip'),
            'JetBrains 插件发布包'
        );

        log(`Antigravity 可执行文件: ${antigravityExe}`);
        log(`PyCharm 启动器: ${pycharmBat}`);
        log(`Cockpit Tools: ${cockpitLauncher}`);
        log(`Antigravity 已安装扩展: ${installedExtensionPath}`);

        await runStep(log, '同步 Antigravity 已安装扩展', 30000, async () => {
            syncInstalledAntigravityExtension(repoRoot, installedExtensionPath);
        });

        await runStep(log, '确保 WinAppDriver 可用', 180000, async () => {
            ensureWinAppDriver(repoRoot, log);
        });

        for (let round = 1; round <= options.rounds; round++) {
            await runRound({
                round,
                options,
                repoRoot,
                runRoot,
                artifactDir,
                log,
                antigravityExe,
                pycharmBat,
                jetbrainsZip,
            });
        }

        log(`全部 ${options.rounds} 轮控件级联调通过。`);
    } finally {
        clearInterval(heartbeat);
    }
}

async function runRound(context) {
    const {
        round,
        options,
        runRoot,
        artifactDir,
        log,
        antigravityExe,
        pycharmBat,
        jetbrainsZip,
    } = context;

    const roundId = `round-${String(round).padStart(2, '0')}`;
    const roundRoot = path.join(runRoot, roundId);
    const hostProject = path.join(roundRoot, `host-project-${roundId}`);
    const guestProject = path.join(roundRoot, `guest-project-${roundId}`);
    const pycharmProfileRoot = path.join(roundRoot, 'pycharm-profile');
    const roundArtifactDir = path.join(artifactDir, roundId);

    ensureCleanDir(roundRoot);
    ensureDir(hostProject);
    ensureDir(guestProject);
    ensureDir(roundArtifactDir);

    const hostFile = path.join(hostProject, 'main.py');
    const guestFile = path.join(guestProject, 'main.py');
    fs.writeFileSync(hostFile, 'print("host base")\n', 'utf8');
    fs.writeFileSync(guestFile, '', 'utf8');

    log(`第 ${round} 轮开始。`);
    const winAppDriverClient = new WinAppDriverClient({ log });
    const nativeDialogDriver = new NativeDialogDriver({
        client: winAppDriverClient,
        artifactDir: roundArtifactDir,
        log,
    });
    const antigravityDriver = new AntigravityDriver({
        cliPath: antigravityExe,
        artifactDir: roundArtifactDir,
        client: winAppDriverClient,
        log,
    });
    const pycharmDriver = new PyCharmDriver({
        pycharmBat,
        pluginZipPath: jetbrainsZip,
        profileRoot: pycharmProfileRoot,
        artifactDir: roundArtifactDir,
        client: winAppDriverClient,
        nativeDialogDriver,
        log,
    });

    try {
        const shareCode = await runStep(log, `第 ${round} 轮启动 Antigravity Host`, options.stepTimeoutMs, async () => {
            await antigravityDriver.openWorkspace(hostProject, hostFile);
            await antigravityDriver.clickShare();
            return await antigravityDriver.getShareCode();
        });
        log(`第 ${round} 轮 share code: ${shareCode}`);

        await runStep(log, `第 ${round} 轮启动 PyCharm Guest`, options.stepTimeoutMs, async () => {
            await pycharmDriver.openProject(guestProject);
            await pycharmDriver.joinSession(shareCode);
        });

        await runStep(log, `第 ${round} 轮首次同步`, options.stepTimeoutMs, async () => {
            await waitForFileContains(guestFile, 'host base', options.stepTimeoutMs);
        });

        const hostMarker = `# HOST_${round}_${Date.now()}`;
        await runStep(log, `第 ${round} 轮 Host -> Guest 增量`, options.stepTimeoutMs, async () => {
            await antigravityDriver.editFile('main.py', hostMarker);
            await waitForFileContains(guestFile, hostMarker, options.stepTimeoutMs);
        });

        const guestMarker = `# GUEST_${round}_${Date.now()}`;
        await runStep(log, `第 ${round} 轮 Guest -> Host 增量`, options.stepTimeoutMs, async () => {
            await pycharmDriver.editFile('main.py', guestMarker);
            await waitForFileContains(hostFile, guestMarker, options.stepTimeoutMs);
        });

        const reconnectMarker = `# REJOIN_${round}_${Date.now()}`;
        await runStep(log, `第 ${round} 轮断开重连`, options.stepTimeoutMs, async () => {
            await pycharmDriver.disconnect();
            await antigravityDriver.waitForGuestLeft();
            await pycharmDriver.joinSession(shareCode);
            await antigravityDriver.editFile('main.py', reconnectMarker);
            await waitForFileContains(guestFile, reconnectMarker, options.stepTimeoutMs);
        });

        log(`第 ${round} 轮通过。`);
    } finally {
        await pycharmDriver.closeProject().catch(() => {});
        await antigravityDriver.dispose().catch(() => {});
    }
}

function parseArgs(argv) {
    const options = {
        antigravityCli: '',
        pycharmBat: '',
        cockpitLauncher: '',
        installedExtensionPath: '',
        jetbrainsZip: '',
        rounds: 3,
        stepTimeoutMs: 120000,
        heartbeatMs: 15000,
        help: false,
    };

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        switch (arg) {
            case '--help':
            case '-h':
                options.help = true;
                break;
            case '--antigravity-cli':
                options.antigravityCli = argv[++index];
                break;
            case '--pycharm-bat':
                options.pycharmBat = argv[++index];
                break;
            case '--cockpit-launcher':
                options.cockpitLauncher = argv[++index];
                break;
            case '--installed-extension':
                options.installedExtensionPath = argv[++index];
                break;
            case '--jetbrains-zip':
                options.jetbrainsZip = argv[++index];
                break;
            case '--rounds':
                options.rounds = Number(argv[++index]);
                break;
            case '--step-timeout-ms':
                options.stepTimeoutMs = Number(argv[++index]);
                break;
            case '--heartbeat-ms':
                options.heartbeatMs = Number(argv[++index]);
                break;
            default:
                throw new Error(`未知参数: ${arg}`);
        }
    }

    return options;
}

function printHelp() {
    console.log([
        '用法: node scripts/gui_cross_ide_e2e.js [options]',
        '',
        '选项:',
        '  --antigravity-cli <path>    指定 antigravity.cmd',
        '  --pycharm-bat <path>        指定 pycharm.bat',
        '  --cockpit-launcher <path>   指定 cockpit-tools.exe',
        '  --installed-extension <dir> 指定 Antigravity 已安装扩展目录',
        '  --jetbrains-zip <path>      指定 JetBrains 插件 ZIP',
        '  --rounds <n>                轮数，默认 3',
        '  --step-timeout-ms <ms>      单步超时，默认 120000',
        '  --heartbeat-ms <ms>         心跳日志间隔，默认 15000',
    ].join('\n'));
}

function createRunId() {
    const now = new Date();
    const parts = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0'),
    ];
    return parts.join('');
}

function createLogger(logFile) {
    return (message) => {
        const line = `[${new Date().toISOString()}] ${message}`;
        fs.appendFileSync(logFile, `${line}\n`, 'utf8');
        console.log(line);
    };
}

function startHeartbeat(log, heartbeatMs) {
    return setInterval(() => {
        log('heartbeat: 控件级联调仍在运行。');
    }, heartbeatMs);
}

async function runStep(log, label, timeoutMs, fn) {
    log(`开始: ${label}`);
    const startedAt = Date.now();
    try {
        const result = await withTimeout(timeoutMs, fn, label);
        log(`完成: ${label} (${Date.now() - startedAt}ms)`);
        return result;
    } catch (error) {
        log(`失败: ${label} -> ${error.message}`);
        throw error;
    }
}

async function withTimeout(timeoutMs, fn, label) {
    return await Promise.race([
        fn(),
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`${label} 超时 ${timeoutMs}ms`)), timeoutMs);
        }),
    ]);
}

function resolveAntigravityExecutable(candidate) {
    const normalizedCandidate =
        candidate && candidate.toLowerCase().endsWith('.cmd')
            ? path.join(path.dirname(path.dirname(candidate)), 'Antigravity.exe')
            : candidate;
    const candidates = [
        normalizedCandidate,
        process.env.ANTIGRAVITY_EXE,
        'E:\\编译器\\Antigravity\\Antigravity.exe',
        'C:\\Program Files\\Antigravity\\Antigravity.exe',
    ].filter(Boolean);
    return resolveFirstExisting(candidates, 'Antigravity.exe');
}

function resolvePyCharmBat(candidate) {
    const candidates = [
        candidate,
        process.env.PYCHARM_BAT,
        'E:\\编译器\\PyCharm Community Edition 2024.3.2\\bin\\pycharm.bat',
        'C:\\Program Files\\JetBrains\\PyCharm Community Edition 2024.3.2\\bin\\pycharm.bat',
    ].filter(Boolean);
    return resolveFirstExisting(candidates, 'pycharm.bat');
}

function resolveCockpitLauncher(candidate) {
    const candidates = [
        candidate,
        process.env.COCKPIT_TOOLS_EXE,
        'C:\\Users\\LX\\AppData\\Local\\Cockpit Tools\\cockpit-tools.exe',
    ].filter(Boolean);
    return resolveFirstExisting(candidates, 'cockpit-tools.exe');
}

function resolveInstalledAntigravityExtension(repoRoot, candidate) {
    const direct = [
        candidate,
        path.join(process.env.USERPROFILE || '', '.antigravity', 'extensions', 'crosside.cross-ide-synergy-3.0.0'),
    ].filter(Boolean);
    for (const option of direct) {
        if (option && fs.existsSync(option)) {
            return option;
        }
    }

    const extensionRoot = path.join(process.env.USERPROFILE || '', '.antigravity', 'extensions');
    const latest = findLatestFile(
        extensionRoot,
        (filePath) => filePath.endsWith(path.join('out', 'extension.js')) && filePath.includes('crosside.cross-ide-synergy-'),
        0
    );
    if (!latest) {
        throw new Error(`未找到已安装的 Cross-IDE Synergy 扩展。仓库: ${repoRoot}`);
    }
    return path.dirname(path.dirname(latest));
}

function syncInstalledAntigravityExtension(repoRoot, installedExtensionPath) {
    const sourceOut = path.join(repoRoot, 'out');
    const sourceAgent = path.join(repoRoot, 'core-agent', 'bundle.js');
    if (!fs.existsSync(sourceOut) || !fs.existsSync(sourceAgent)) {
        throw new Error('缺少打包产物，请先执行 npm run build:release。');
    }

    copyRecursive(sourceOut, path.join(installedExtensionPath, 'out'));
    copyRecursive(sourceAgent, path.join(installedExtensionPath, 'core-agent', 'bundle.js'));
}

function ensureWinAppDriver(repoRoot, log) {
    if (findWinAppDriverExe()) {
        return;
    }

    const installerScript = path.join(repoRoot, 'scripts', 'install_winappdriver.ps1');
    const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installerScript],
        {
            cwd: repoRoot,
            stdio: 'inherit',
            windowsHide: false,
        }
    );
    if (result.status !== 0 || !findWinAppDriverExe()) {
        throw new Error('WinAppDriver 安装失败。');
    }
    log('WinAppDriver 安装完成。');
}

async function waitForFileContains(filePath, needle, timeoutMs) {
    await waitUntil(`文件 ${path.basename(filePath)} 包含 ${needle}`, timeoutMs, async () => {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        return content.includes(needle) ? true : null;
    }, 1000);
}

function resolveExistingFile(candidate, label) {
    if (!candidate || !fs.existsSync(candidate)) {
        throw new Error(`${label} 不存在: ${candidate}`);
    }
    return candidate;
}

function resolveFirstExisting(candidates, label) {
    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error(`未找到 ${label}`);
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
