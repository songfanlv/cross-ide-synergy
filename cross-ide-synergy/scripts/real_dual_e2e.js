const path = require('path');
const { spawn, execFile } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const AGENT_ENTRY = process.env.CROSSIDE_AGENT_ENTRY || path.join(ROOT, 'core-agent', 'bundle.js');
const HOST_PORT = Number(process.env.CROSSIDE_HOST_PORT || 37169);
const GUEST_PORT = Number(process.env.CROSSIDE_GUEST_PORT || 37170);
const ROUND_COUNT = Number(process.env.CROSSIDE_ROUNDS || 5);
const OPEN_TIMEOUT_MS = 15000;
const RPC_TIMEOUT_MS = 20000;
const MESSAGE_TIMEOUT_MS = 20000;
const POLL_TIMEOUT_MS = 15000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const result = await predicate();
        if (result) {
            return result;
        }
        await sleep(250);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function startAgent(port, name) {
    const proc = spawn(process.execPath, [AGENT_ENTRY], {
        cwd: ROOT,
        env: {
            ...process.env,
            CROSSIDE_PORT: String(port),
            CROSSIDE_NO_BROWSER: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    proc.stdout.on('data', (chunk) => {
        process.stdout.write(`[${name}] ${chunk}`);
    });

    proc.stderr.on('data', (chunk) => {
        process.stderr.write(`[${name}:stderr] ${chunk}`);
    });

    return proc;
}

function waitForExit(proc) {
    return new Promise((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
            resolve();
            return;
        }

        proc.once('exit', () => resolve());
    });
}

async function terminateProcess(proc) {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
        return;
    }

    proc.kill();
    const exited = waitForExit(proc);
    const timeout = sleep(3000).then(() => false);

    if (await Promise.race([exited.then(() => true), timeout])) {
        return;
    }

    if (process.platform === 'win32') {
        await new Promise((resolve) => {
            execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
        });
        await waitForExit(proc);
        return;
    }

    proc.kill('SIGKILL');
    await waitForExit(proc);
}

class JsonWsClient {
    constructor(name, port) {
        this.name = name;
        this.port = port;
        this.ws = null;
        this.queue = [];
        this.waiters = [];
    }

    async connect() {
        const deadline = Date.now() + OPEN_TIMEOUT_MS;
        let lastError = null;

        while (Date.now() < deadline) {
            try {
                await this.tryConnectOnce();
                return;
            } catch (err) {
                lastError = err;
                await sleep(500);
            }
        }

        throw new Error(`Failed to connect ${this.name}: ${lastError?.message ?? 'unknown error'}`);
    }

    tryConnectOnce() {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
            const timer = setTimeout(() => {
                ws.terminate();
                reject(new Error('open timeout'));
            }, 2000);

            ws.once('open', () => {
                clearTimeout(timer);
                this.ws = ws;
                ws.on('message', (data) => this.handleMessage(data));
                ws.on('close', () => {
                    this.ws = null;
                });
                resolve();
            });

            ws.once('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    handleMessage(data) {
        const message = JSON.parse(data.toString());
        for (let i = 0; i < this.waiters.length; i++) {
            const waiter = this.waiters[i];
            if (waiter.predicate(message)) {
                this.waiters.splice(i, 1);
                waiter.resolve(message);
                return;
            }
        }
        this.queue.push(message);
    }

    send(message) {
        assert(this.ws && this.ws.readyState === WebSocket.OPEN, `${this.name} is not connected`);
        this.ws.send(JSON.stringify(message));
    }

    waitForMessage(predicate, label, timeoutMs = MESSAGE_TIMEOUT_MS) {
        for (let i = 0; i < this.queue.length; i++) {
            if (predicate(this.queue[i])) {
                return Promise.resolve(this.queue.splice(i, 1)[0]);
            }
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter((entry) => entry !== waiter);
                reject(new Error(`Timed out waiting for ${this.name} ${label}`));
            }, timeoutMs);

            const waiter = {
                predicate,
                resolve: (message) => {
                    clearTimeout(timer);
                    resolve(message);
                },
            };

            this.waiters.push(waiter);
        });
    }

    async rpc(method, params = {}) {
        const id = `${this.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.send({ jsonrpc: '2.0', method, params, id });
        const response = await this.waitForMessage(
            (message) => message.id === id && (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error')),
            `rpc ${method}`,
            RPC_TIMEOUT_MS
        );

        if (response.error) {
            throw new Error(`${method} failed: ${response.error.message}`);
        }

        return response.result;
    }

    async close() {
        if (!this.ws) {
            return;
        }

        const ws = this.ws;
        await new Promise((resolve) => {
            ws.once('close', resolve);
            ws.close();
        });
    }
}

async function runRound(round, hostClient, guestClient) {
    console.log(`\n[Round ${round}] Starting`);

    const hostResult = await hostClient.rpc('start_host');
    const shareCode = hostResult.shareCode;
    assert(typeof shareCode === 'string' && shareCode.length === 6, `[Round ${round}] invalid share code`);

    const guestJoinPromise = hostClient.waitForMessage(
        (message) => message.type === 'session_event' && message.event === 'join',
        'guest join'
    );
    await guestClient.rpc('start_guest', { shareCode });
    const joinMessage = await guestJoinPromise;
    assert(typeof joinMessage.guestId === 'string', `[Round ${round}] missing guestId`);

    await waitFor(async () => {
        const status = await hostClient.rpc('get_status');
        return status.remoteClients === 1 ? status : null;
    }, POLL_TIMEOUT_MS, `round ${round} host remoteClients=1`);

    const initialSyncPayload = {
        type: 'workspace_sync',
        files: [
            {
                filePath: `round-${round}/hello.txt`,
                content: `workspace-sync-${round}`,
            },
        ],
        batchIndex: 0,
        totalBatches: 1,
    };
    const initialSyncPromise = guestClient.waitForMessage(
        (message) =>
            message.type === 'workspace_sync' &&
            message.files?.[0]?.filePath === initialSyncPayload.files[0].filePath &&
            message.files?.[0]?.content === initialSyncPayload.files[0].content,
        'initial workspace sync'
    );
    hostClient.send(initialSyncPayload);
    await initialSyncPromise;

    const guestChange = {
        type: 'change',
        filePath: `round-${round}/hello.txt`,
        changes: [
            {
                startLine: 0,
                startChar: 0,
                endLine: 0,
                endChar: 0,
                text: `guest-change-${round}`,
            },
        ],
        senderId: `guest-${round}`,
    };
    const guestChangePromise = hostClient.waitForMessage(
        (message) =>
            message.type === 'change' &&
            message.senderId === guestChange.senderId &&
            message.changes?.[0]?.text === guestChange.changes[0].text,
        'guest incremental change'
    );
    guestClient.send(guestChange);
    await guestChangePromise;

    const hostChange = {
        type: 'change',
        filePath: `round-${round}/hello.txt`,
        changes: [
            {
                startLine: 0,
                startChar: 0,
                endLine: 0,
                endChar: 0,
                text: `host-change-${round}`,
            },
        ],
        senderId: `host-${round}`,
    };
    const hostChangePromise = guestClient.waitForMessage(
        (message) =>
            message.type === 'change' &&
            message.senderId === hostChange.senderId &&
            message.changes?.[0]?.text === hostChange.changes[0].text,
        'host incremental change'
    );
    hostClient.send(hostChange);
    await hostChangePromise;

    const leavePromise = hostClient.waitForMessage(
        (message) =>
            message.type === 'session_event' &&
            message.event === 'leave' &&
            message.guestId === joinMessage.guestId,
        'guest leave'
    );
    await guestClient.rpc('stop_session');
    await leavePromise;

    await waitFor(async () => {
        const status = await hostClient.rpc('get_status');
        return status.remoteClients === 0 ? status : null;
    }, POLL_TIMEOUT_MS, `round ${round} host remoteClients=0`);

    const rejoinPromise = hostClient.waitForMessage(
        (message) =>
            message.type === 'session_event' &&
            message.event === 'join' &&
            message.guestId === joinMessage.guestId,
        'guest rejoin'
    );
    await guestClient.rpc('start_guest', { shareCode });
    await rejoinPromise;

    const reconnectPayload = {
        type: 'workspace_sync',
        files: [
            {
                filePath: `round-${round}/reconnect.txt`,
                content: `reconnect-sync-${round}`,
            },
        ],
        batchIndex: 0,
        totalBatches: 1,
    };
    const reconnectPromise = guestClient.waitForMessage(
        (message) =>
            message.type === 'workspace_sync' &&
            message.files?.[0]?.filePath === reconnectPayload.files[0].filePath &&
            message.files?.[0]?.content === reconnectPayload.files[0].content,
        'reconnect workspace sync'
    );
    hostClient.send(reconnectPayload);
    await reconnectPromise;

    const finalLeavePromise = hostClient.waitForMessage(
        (message) =>
            message.type === 'session_event' &&
            message.event === 'leave' &&
            message.guestId === joinMessage.guestId,
        'final guest leave'
    );
    await guestClient.rpc('stop_session');
    await finalLeavePromise;
    await hostClient.rpc('stop_session');

    console.log(`[Round ${round}] Passed`);
}

async function main() {
    const hostAgent = startAgent(HOST_PORT, 'host-agent');
    const guestAgent = startAgent(GUEST_PORT, 'guest-agent');
    const hostClient = new JsonWsClient('host', HOST_PORT);
    const guestClient = new JsonWsClient('guest', GUEST_PORT);

    const shutdown = async () => {
        await Promise.allSettled([hostClient.close(), guestClient.close()]);
        await Promise.allSettled([terminateProcess(hostAgent), terminateProcess(guestAgent)]);
    };

    try {
        await Promise.all([hostClient.connect(), guestClient.connect()]);

        for (let round = 1; round <= ROUND_COUNT; round++) {
            await runRound(round, hostClient, guestClient);
        }

        console.log(`\nAll ${ROUND_COUNT} rounds passed.`);
    } finally {
        await shutdown();
    }
}

main().catch((err) => {
    console.error(`\nE2E failed: ${err.stack || err.message}`);
    process.exitCode = 1;
});
