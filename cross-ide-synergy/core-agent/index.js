const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { connectWithFallback } = require('./brokers');

const logFile = path.join(__dirname, 'agent-runtime.log');

function logAgent(msg) {
    const time = new Date().toISOString();
    const line = `[${time}] ${msg}\n`;
    process.stdout.write(line);
    try {
        fs.appendFileSync(logFile, line);
    } catch {
        // Ignore log file write errors.
    }
}

class CoreAgent {
    constructor(port = 36969) {
        this.port = port;
        this.httpServer = null;
        this.localWss = null;
        this.localClients = new Set();
        this.mqttClient = null;
        this.shareCode = null;
        this.role = null;
        this.remoteClients = new Map();
        this.hasAutoOpened = false;
        this.instanceId = `agent-${Math.random().toString(36).slice(2, 10)}`;
        this.mqttMessageHandler = null;
    }

    start() {
        logAgent(`[Core Agent] Starting on port ${this.port}`);

        try {
            this.httpServer = http.createServer((req, res) => {
                if (req.url === '/' || req.url === '/index.html') {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(this.getConsoleHtml());
                    return;
                }

                res.writeHead(404);
                res.end();
            });

            this.localWss = new WebSocket.Server({ server: this.httpServer });
            this.localWss.on('connection', (ws) => {
                this.handleLocalPluginConnection(ws);
            });

            this.httpServer.listen(this.port, () => {
                logAgent(`[Core Agent] HTTP + WebSocket ready at http://localhost:${this.port}`);
            });
        } catch (err) {
            logAgent(`[Core Agent] Startup failed: ${err.message}`);
            process.exit(1);
        }
    }

    getConsoleHtml() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cross-IDE Sidecar</title>
    <style>
        :root {
            --bg: #101820;
            --card: #182632;
            --text: #f2efe8;
            --muted: #9cb3c5;
            --accent: #f25f4c;
            --accent-2: #247ba0;
            --ok: #70c1b3;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            background:
                radial-gradient(circle at top left, rgba(242,95,76,0.18), transparent 28%),
                radial-gradient(circle at bottom right, rgba(36,123,160,0.22), transparent 30%),
                var(--bg);
            color: var(--text);
            font-family: "Segoe UI", system-ui, sans-serif;
        }
        .card {
            width: min(520px, calc(100vw - 32px));
            background: rgba(24, 38, 50, 0.94);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 20px;
            padding: 28px;
            box-shadow: 0 24px 80px rgba(0,0,0,0.35);
        }
        h1 { margin: 0 0 8px; font-size: 28px; }
        p { margin: 0; color: var(--muted); }
        .status {
            margin: 20px 0;
            padding: 12px 14px;
            border-radius: 12px;
            background: rgba(255,255,255,0.05);
        }
        .status strong { color: var(--ok); }
        .actions { display: grid; gap: 12px; margin-top: 18px; }
        button, input {
            width: 100%;
            border-radius: 12px;
            border: none;
            padding: 14px 16px;
            font-size: 15px;
        }
        input {
            background: rgba(255,255,255,0.08);
            color: var(--text);
            border: 1px solid rgba(255,255,255,0.12);
            text-transform: uppercase;
            letter-spacing: 0.18em;
            text-align: center;
        }
        button {
            cursor: pointer;
            color: white;
            font-weight: 700;
        }
        .primary { background: var(--accent); }
        .secondary { background: var(--accent-2); }
        .danger { background: #c1121f; }
        .meta {
            display: grid;
            gap: 8px;
            margin-top: 18px;
            padding-top: 18px;
            border-top: 1px solid rgba(255,255,255,0.08);
            color: var(--muted);
            font-size: 14px;
        }
        code { color: white; font-size: 18px; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Cross-IDE Sidecar</h1>
        <p>Local controller for cross-IDE collaboration.</p>
        <div class="status" id="status">Connecting...</div>
        <div class="actions">
            <button class="primary" onclick="startHost()">Start Host Session</button>
            <input id="shareCode" placeholder="ENTER CODE" maxlength="6" />
            <button class="secondary" onclick="startGuest()">Join Session</button>
            <button class="danger" onclick="stopSession()">Stop Session</button>
        </div>
        <div class="meta">
            <div>Role: <strong id="role">idle</strong></div>
            <div>Share code: <code id="code">-</code></div>
            <div>Guests: <span id="guests">0</span></div>
        </div>
    </div>
    <script>
        const ws = new WebSocket('ws://' + window.location.host);

        ws.onopen = () => {
            refresh();
            setInterval(refresh, 2000);
        };

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.result) {
                render(data.result);
            }
        };

        ws.onclose = () => {
            document.getElementById('status').textContent = 'Agent disconnected';
        };

        function call(method, params = {}) {
            ws.send(JSON.stringify({ method, params, id: Date.now() }));
        }

        function refresh() {
            call('get_status');
        }

        function startHost() {
            call('start_host');
        }

        function startGuest() {
            const shareCode = document.getElementById('shareCode').value.trim().toUpperCase();
            if (!shareCode) {
                alert('Enter a share code first.');
                return;
            }
            call('start_guest', { shareCode });
        }

        function stopSession() {
            call('stop_session');
        }

        function render(status) {
            document.getElementById('status').innerHTML = 'Cloud connected: <strong>' + (status.isCloudConnected ? 'yes' : 'no') + '</strong>';
            document.getElementById('role').textContent = status.role || 'idle';
            document.getElementById('code').textContent = status.shareCode || '-';
            document.getElementById('guests').textContent = String(status.remoteClients || 0);
        }
    </script>
</body>
</html>`;
    }

    handleLocalPluginConnection(ws) {
        this.localClients.add(ws);
        logAgent(`[Local] IDE plugin connected (${this.localClients.size})`);

        ws.on('message', (message) => {
            const data = message.toString();

            try {
                const json = JSON.parse(data);
                if (json.method) {
                    this.handleRpcCall(ws, json);
                    return;
                }

                this.broadcastLocal(data, ws);
                this.forwardToCloud(data);
            } catch (err) {
                logAgent(`[Local] Invalid JSON from client: ${err.message}`);
            }
        });

        ws.on('close', () => {
            this.localClients.delete(ws);
            logAgent(`[Local] IDE plugin disconnected (${this.localClients.size})`);
        });

        ws.send(JSON.stringify({ type: 'notification', message: 'Sidecar connected' }));

        if (!this.hasAutoOpened && process.env.CROSSIDE_NO_BROWSER !== '1') {
            this.hasAutoOpened = true;
            const url = `http://localhost:${this.port}`;
            const openCommand = process.platform === 'win32'
                ? `start "" "${url}"`
                : process.platform === 'darwin'
                    ? `open "${url}"`
                    : `xdg-open "${url}"`;

            exec(openCommand, (err) => {
                if (err) {
                    logAgent(`[Core Agent] Failed to open browser: ${err.message}`);
                }
            });
        }
    }

    async handleRpcCall(ws, rpc) {
        const { method, params = {}, id } = rpc;
        const response = { jsonrpc: '2.0', id, result: null, error: null };
        const shouldLogRpc = method !== 'get_status';
        if (shouldLogRpc) {
            logAgent(`[RPC] Received ${method} (${id})`);
        }

        try {
            switch (method) {
                case 'start_host':
                    await this.stopMqtt();
                    this.role = 'host';
                    this.shareCode = (params.shareCode || Math.random().toString(36).substring(2, 8)).toUpperCase();
                    this.remoteClients.clear();
                    await this.connectMqtt();
                    response.result = { shareCode: this.shareCode };
                    break;

                case 'start_guest':
                    await this.stopMqtt();
                    this.role = 'guest';
                    this.shareCode = String(params.shareCode || '').trim().toUpperCase();
                    if (!this.shareCode) {
                        throw new Error('shareCode is required');
                    }
                    await this.connectMqtt();
                    response.result = { shareCode: this.shareCode };
                    break;

                case 'stop_session':
                    await this.stopMqtt();
                    this.role = null;
                    this.shareCode = null;
                    this.remoteClients.clear();
                    response.result = 'ok';
                    break;

                case 'get_status':
                    response.result = {
                        role: this.role,
                        shareCode: this.shareCode,
                        localClients: this.localClients.size,
                        remoteClients: this.remoteClients.size,
                        isCloudConnected: this.mqttClient?.connected || false,
                    };
                    break;

                default:
                    response.error = { code: -32601, message: 'Method not found' };
            }
        } catch (err) {
            response.error = { code: -32000, message: err.message };
        }

        if (shouldLogRpc) {
            logAgent(`[RPC] Responding to ${method} (${id})`);
        }
        ws.send(JSON.stringify(response));
    }

    async connectMqtt() {
        const { client, brokerName } = await connectWithFallback({
            logFn: (msg) => logAgent(`[Cloud] ${msg}`),
        });

        this.mqttClient = client;
        this.setupMqttSubscriptions();
        logAgent(`[Cloud] Connected via ${brokerName}`);
    }

    setupMqttSubscriptions() {
        if (!this.mqttClient || !this.shareCode) {
            return;
        }

        const baseTopic = `crosside/share/${this.shareCode}`;
        this.mqttMessageHandler = (topic, message) => {
            this.handleCloudMessage(topic, message.toString());
        };

        if (this.role === 'host') {
            this.mqttClient.subscribe(`${baseTopic}/join`, { qos: 1 });
            this.mqttClient.subscribe(`${baseTopic}/leave`, { qos: 1 });
            this.mqttClient.subscribe(`${baseTopic}/data/host/#`, { qos: 1 });
        } else {
            this.mqttClient.subscribe(`${baseTopic}/data/guest/all`, { qos: 1 });
            this.mqttClient.subscribe(`${baseTopic}/data/guest/${this.instanceId}`, { qos: 1 });
            this.mqttClient.publish(
                `${baseTopic}/join`,
                JSON.stringify({ type: 'session_event', event: 'join', guestId: this.instanceId }),
                { qos: 1 }
            );
        }

        this.mqttClient.on('message', this.mqttMessageHandler);
    }

    handleCloudMessage(topic, payload) {
        try {
            const json = JSON.parse(payload);
            if (json.type === 'session_event' && typeof json.guestId === 'string') {
                if (json.event === 'join') {
                    this.remoteClients.set(json.guestId, { lastSeen: Date.now() });
                } else if (json.event === 'leave') {
                    this.remoteClients.delete(json.guestId);
                }
            }
        } catch {
            // Ignore non-JSON payloads here, they still need to be forwarded locally.
        }

        this.broadcastLocal(payload, null);
    }

    forwardToCloud(dataStr) {
        if (!this.mqttClient?.connected || !this.shareCode) {
            return;
        }

        const baseTopic = `crosside/share/${this.shareCode}`;
        if (this.role === 'host') {
            this.mqttClient.publish(`${baseTopic}/data/guest/all`, dataStr, { qos: 1 });
            return;
        }

        this.mqttClient.publish(`${baseTopic}/data/host/${this.instanceId}`, dataStr, { qos: 1 });
    }

    broadcastLocal(data, excludeWs) {
        this.localClients.forEach((client) => {
            if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        });
    }

    async stopMqtt() {
        if (!this.mqttClient) {
            return;
        }

        if (this.role === 'guest' && this.shareCode && this.mqttClient.connected) {
            const baseTopic = `crosside/share/${this.shareCode}`;
            this.mqttClient.publish(
                `${baseTopic}/leave`,
                JSON.stringify({ type: 'session_event', event: 'leave', guestId: this.instanceId }),
                { qos: 1 }
            );
        }

        if (this.mqttMessageHandler) {
            this.mqttClient.removeListener('message', this.mqttMessageHandler);
            this.mqttMessageHandler = null;
        }

        await new Promise((resolve) => {
            this.mqttClient.end(false, {}, resolve);
        });

        this.mqttClient = null;
    }
}

const configuredPort = Number(process.env.CROSSIDE_PORT || 36969);
const agent = new CoreAgent(Number.isFinite(configuredPort) ? configuredPort : 36969);
agent.start();
