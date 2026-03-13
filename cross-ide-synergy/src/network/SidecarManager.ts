import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as net from 'net';
import WebSocket from 'ws';

export class SidecarManager {
    private agentProcess: cp.ChildProcess | null = null;
    private ws: WebSocket | null = null;
    private isInternalStopping = false;
    private port: number | null = null;
    private readonly log: (msg: string) => void;

    constructor(logFn: (msg: string) => void) {
        this.log = logFn;
    }

    public async ensureStarted(context: vscode.ExtensionContext): Promise<void> {
        if (this.ws?.readyState === WebSocket.OPEN) {
            return;
        }

        const agentPath = path.join(context.extensionPath, 'core-agent', 'bundle.js');
        if (!fs.existsSync(agentPath)) {
            throw new Error(`Sidecar bundle not found: ${agentPath}`);
        }

        if (!this.port) {
            this.port = await this.findAvailablePort();
        }

        if (!this.agentProcess || this.agentProcess.killed) {
            this.startAgentProcess(agentPath, this.port);
        }

        await this.connectWithRetry(15);
    }

    private async findAvailablePort(): Promise<number> {
        return await new Promise<number>((resolve, reject) => {
            const server = net.createServer();
            server.unref();
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                const address = server.address();
                if (!address || typeof address === 'string') {
                    server.close(() => reject(new Error('Unable to allocate sidecar port')));
                    return;
                }
                const { port } = address;
                server.close((err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve(port);
                });
            });
        });
    }

    private startAgentProcess(agentPath: string, port: number): void {
        this.isInternalStopping = false;
        this.log(`[Sidecar] Starting agent on port ${port}: ${process.execPath} "${agentPath}"`);

        this.agentProcess = cp.spawn(process.execPath, [agentPath], {
            cwd: path.dirname(agentPath),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: {
                ...process.env,
                CROSSIDE_PORT: String(port),
                CROSSIDE_NO_BROWSER: '1',
            },
        });

        this.agentProcess.stdout?.on('data', (chunk: Buffer | string) => {
            const text = chunk.toString().trim();
            if (text) {
                this.log(`[Sidecar] ${text}`);
            }
        });

        this.agentProcess.stderr?.on('data', (chunk: Buffer | string) => {
            const text = chunk.toString().trim();
            if (text) {
                this.log(`[Sidecar][stderr] ${text}`);
            }
        });

        this.agentProcess.once('error', (err) => {
            this.log(`[Sidecar] Failed to start agent: ${err.message}`);
        });

        this.agentProcess.once('exit', (code, signal) => {
            this.agentProcess = null;
            this.ws = null;
            if (!this.isInternalStopping) {
                this.log(`[Sidecar] Agent exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
            }
        });
    }

    private async connectWithRetry(retries = 5): Promise<void> {
        if (!this.port) {
            throw new Error('Sidecar port is not initialized');
        }

        for (let i = 0; i < retries; i++) {
            try {
                this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
                await new Promise<void>((resolve, reject) => {
                    this.ws!.once('open', () => resolve());
                    this.ws!.once('error', reject);
                    setTimeout(() => reject(new Error('timeout')), 2000);
                });
                this.log('[Sidecar] Connected to agent');
                this.setupWsListeners();
                return;
            } catch {
                this.log(`[Sidecar] Waiting for agent (${i + 1}/${retries})...`);
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }

        throw new Error('Unable to connect to Sidecar Agent');
    }

    private setupWsListeners(): void {
        if (!this.ws) {
            return;
        }

        this.ws.on('close', () => {
            if (!this.isInternalStopping) {
                this.log('[Sidecar] Agent socket closed unexpectedly');
            }
        });

        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'notification') {
                    vscode.window.setStatusBarMessage(`[Cross-IDE] ${msg.message}`, 3000);
                }
            } catch {
                // Ignore malformed sidecar messages.
            }
        });
    }

    public callRpc(method: string, params: any = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('Sidecar is not connected'));
                return;
            }

            const id = Math.random().toString(36).substring(2, 10);
            const request = { jsonrpc: '2.0', method, params, id };

            const listener = (data: Buffer) => {
                const response = JSON.parse(data.toString());
                if (response.id === id) {
                    this.ws?.removeListener('message', listener);
                    if (response.error) {
                        reject(response.error);
                    } else {
                        resolve(response.result);
                    }
                }
            };

            this.ws.on('message', listener);
            this.ws.send(JSON.stringify(request));
        });
    }

    public sendMessage(msg: any): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    public onMessage(callback: (msg: any) => void): void {
        this.ws?.on('message', (data) => {
            try {
                const json = JSON.parse(data.toString());
                const isRpcResponse = json.jsonrpc === '2.0' && Object.prototype.hasOwnProperty.call(json, 'id');
                if (!json.method && !isRpcResponse) {
                    callback(json);
                }
            } catch {
                // Ignore malformed sidecar messages.
            }
        });
    }

    public stop(): void {
        this.isInternalStopping = true;
        this.ws?.close();
        this.ws = null;
        if (this.agentProcess) {
            this.agentProcess.kill();
            this.agentProcess = null;
        }
    }
}
