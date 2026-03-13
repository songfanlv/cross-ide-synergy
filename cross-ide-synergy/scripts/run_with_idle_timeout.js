const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const options = {
        cwd: process.cwd(),
        idleMs: 5 * 60 * 1000,
        maxMs: 30 * 60 * 1000,
        heartbeatMs: 30 * 1000,
        logFile: null,
        command: null,
        args: [],
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--cwd') {
            options.cwd = argv[++i];
            continue;
        }
        if (arg === '--idle-ms') {
            options.idleMs = Number(argv[++i]);
            continue;
        }
        if (arg === '--heartbeat-ms') {
            options.heartbeatMs = Number(argv[++i]);
            continue;
        }
        if (arg === '--max-ms') {
            options.maxMs = Number(argv[++i]);
            continue;
        }
        if (arg === '--log-file') {
            options.logFile = argv[++i];
            continue;
        }
        if (arg === '--') {
            options.command = argv[++i];
            options.args = argv.slice(i + 1);
            break;
        }
    }

    if (!options.command) {
        throw new Error('Missing command. Usage: node run_with_idle_timeout.js --cwd <dir> --log-file <file> -- <command> [...args]');
    }

    return options;
}

function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function killTree(pid) {
    if (!pid) {
        return;
    }

    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
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

function main() {
    const options = parseArgs(process.argv.slice(2));
    const startedAt = Date.now();
    let lastOutputAt = Date.now();
    let idleKilled = false;
    let maxKilled = false;

    if (options.logFile) {
        fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
    }

    const logStream = options.logFile ? fs.createWriteStream(options.logFile, { flags: 'a' }) : null;
    const writeOutput = (chunk, target) => {
        const text = chunk.toString();
        lastOutputAt = Date.now();
        target.write(text);
        logStream?.write(text);
    };

    const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        shell: process.platform === 'win32',
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk) => writeOutput(chunk, process.stdout));
    child.stderr.on('data', (chunk) => writeOutput(chunk, process.stderr));

    const heartbeat = setInterval(() => {
        const now = Date.now();
        const elapsed = formatDuration(now - startedAt);
        const idle = formatDuration(now - lastOutputAt);
        const line = `[watchdog] elapsed=${elapsed} idle=${idle}\n`;
        process.stdout.write(line);
        logStream?.write(line);

        if (now - startedAt > options.maxMs) {
            maxKilled = true;
            const timeoutLine = `[watchdog] max runtime ${formatDuration(options.maxMs)} exceeded, terminating process tree\n`;
            process.stderr.write(timeoutLine);
            logStream?.write(timeoutLine);
            killTree(child.pid);
            clearInterval(heartbeat);
            return;
        }

        if (now - lastOutputAt > options.idleMs) {
            idleKilled = true;
            const timeoutLine = `[watchdog] no output for ${formatDuration(now - lastOutputAt)}, terminating process tree\n`;
            process.stderr.write(timeoutLine);
            logStream?.write(timeoutLine);
            killTree(child.pid);
            clearInterval(heartbeat);
        }
    }, options.heartbeatMs);

    child.once('exit', (code, signal) => {
        clearInterval(heartbeat);
        logStream?.end();
        if (idleKilled || maxKilled) {
            process.exitCode = 124;
            return;
        }
        if (signal) {
            process.exitCode = 1;
            return;
        }
        process.exitCode = code ?? 1;
    });

    child.once('error', (error) => {
        clearInterval(heartbeat);
        process.stderr.write(`${error.stack || error.message}\n`);
        logStream?.end();
        process.exitCode = 1;
    });
}

main();
