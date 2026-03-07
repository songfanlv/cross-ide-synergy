/**
 * GuestClient - 协同编辑的访客端客户端 (v3.0 纯 JS 稳定版)
 * 连接方式：MQTT 中继 (主) + WebSocket 中继 (备)
 * 
 * 【v3.0 核心变更】
 * - 移除 WebRTC 逻辑，避免原生模块崩溃
 * - 移除 LocalTunnel 逻辑
 * - 简化连接流程：直接进入 MQTT 握手
 */

import * as vscode from 'vscode';
import * as mqtt from 'mqtt';
import WebSocket from 'ws';
import { MQTT_BROKERS, connectToBroker, formatError, DEFAULT_RELAY_URL } from './brokers';
import { ShareMessage } from './protocol';

/** 连接模式 */
type ChannelMode = 'mqtt' | 'ws';

export class GuestClient {
    private mqttClient: mqtt.MqttClient | null = null;
    private wsRelay: WebSocket | null = null;
    private guestId: string;
    private shareCode: string = '';

    private _connected: boolean = false;
    private _mode: ChannelMode = 'mqtt';
    private log: (msg: string) => void;

    /** 心跳保活定时器 */
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    /** 是否正在主动断开 */
    private isDisconnecting: boolean = false;

    public onMessage: ((msg: ShareMessage) => void) | null = null;
    public onConnected: (() => void) | null = null;
    public onDisconnected: ((reason: string) => void) | null = null;

    constructor(logFn: (msg: string) => void) {
        this.log = logFn;
        this.guestId = Math.random().toString(36).substring(2, 10);
    }

    get connected(): boolean { return this._connected; }
    get mode(): ChannelMode { return this._mode; }

    async connect(shareCode: string): Promise<void> {
        this.shareCode = shareCode.trim().toUpperCase();
        this.isDisconnecting = false;
        this.log(`[Guest] 正在连接 (v3.0 纯 JS 架构)...`);

        const brokerErrors: string[] = [];

        // ① 尝试 MQTT Brokers
        for (let i = 0; i < MQTT_BROKERS.length; i++) {
            const broker = MQTT_BROKERS[i];
            try {
                const result = await this.tryBrokerConnect(broker.url, broker.name);
                if (result) {
                    this.startHeartbeat();
                    this.setupMqttMonitoring();
                    return;
                }
                brokerErrors.push(`${broker.name}: 超时`);
            } catch (err: any) {
                brokerErrors.push(`${broker.name}: ${formatError(err)}`);
            }
        }

        // ② 尝试 WebSocket 中继
        this.log(`[Guest] MQTT 失败，尝试 WS 中继...`);
        return this.tryWsRelayFallback(brokerErrors);
    }

    private tryBrokerConnect(brokerUrl: string, brokerName: string): Promise<boolean> {
        return new Promise(async (resolve, reject) => {
            let client: mqtt.MqttClient | null = null;
            let hostResponded = false;

            try {
                client = await connectToBroker(this.log, brokerUrl, brokerName, 6000);
            } catch (err: any) { reject(err); return; }

            const timer = setTimeout(() => {
                if (!hostResponded) {
                    client?.end(true);
                    resolve(false);
                }
            }, 8000);

            client.on('message', (topic, message) => {
                try {
                    const payload = JSON.parse(message.toString());
                    const action = topic.split('/').pop();

                    if (action === 'relay' && !hostResponded) {
                        hostResponded = true;
                        clearTimeout(timer);
                        this.mqttClient = client;
                        this._mode = 'mqtt';
                        this._connected = true;
                        this.log(`[Guest] ✅ 在 ${brokerName} 上连接成功`);
                        this.onConnected?.();
                        resolve(true);
                    }

                    if (topic === `antigravity/share/${this.shareCode}/data/${this.guestId}`) {
                        this.onMessage?.(payload);
                    }
                } catch (e) { }
            });

            const signalingTopic = `antigravity/share/${this.shareCode}/guest/${this.guestId}/#`;
            const dataTopic = `antigravity/share/${this.shareCode}/data/${this.guestId}`;

            client.subscribe([signalingTopic, dataTopic], { qos: 1 }, () => {
                client?.publish(`antigravity/share/${this.shareCode}/join`, JSON.stringify({ guestId: this.guestId }), { qos: 1 });
            });
        });
    }

    private startHeartbeat() {
        this.heartbeatTimer = setInterval(() => {
            if (this.mqttClient?.connected) {
                this.mqttClient.publish(`antigravity/share/${this.shareCode}/keepalive`, JSON.stringify({ id: this.guestId }), { qos: 0 });
            }
        }, 15000); // [修复Bug 2] 将心跳包发送频率由25秒提速为15秒一次，防止拥堵掉线
    }

    private setupMqttMonitoring() {
        this.mqttClient?.on('close', () => { if (!this.isDisconnecting) this.log(`[Guest] ⚠️ 连接关断`); });
    }

    private tryWsRelayFallback(brokerErrors: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const relayUrl = vscode.workspace.getConfiguration('antigravity').get<string>('relayUrl', '') || DEFAULT_RELAY_URL;
            if (!relayUrl) {
                reject(new Error(`无法连接：所有通道均失败。\n${brokerErrors.join('\n')}`));
                this.disconnect();
                return;
            }

            try {
                const wsUrl = relayUrl.replace(/^http/, 'ws') + `/relay/${this.shareCode}?role=guest&guestId=${this.guestId}`;
                this.wsRelay = new WebSocket(wsUrl);

                this.wsRelay.on('open', () => {
                    this._mode = 'ws';
                    this._connected = true;
                    this.onConnected?.();
                    resolve();
                });
                this.wsRelay.on('message', (data) => {
                    try { this.onMessage?.(JSON.parse(data.toString())); } catch (e) { }
                });
                this.wsRelay.on('error', (e) => reject(e));
                this.wsRelay.on('close', () => this.disconnect());
            } catch (e) { reject(e); }
        });
    }

    send(msg: ShareMessage): void {
        if (!this._connected) return;
        try {
            const data = JSON.stringify(msg);
            if (this._mode === 'mqtt' && this.mqttClient) {
                this.mqttClient.publish(`antigravity/share/${this.shareCode}/data/host/${this.guestId}`, data, { qos: 1 });
            } else if (this._mode === 'ws' && this.wsRelay?.readyState === WebSocket.OPEN) {
                this.wsRelay.send(data);
            }
        } catch (e) { }
    }

    disconnect(): void {
        this.isDisconnecting = true;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

        try {
            if (this.mqttClient && this._connected) {
                // 发送离线通知，让 Host 的状态栏秒变为准确数字
                this.mqttClient.publish(
                    `antigravity/share/${this.shareCode}/leave`,
                    JSON.stringify({ guestId: this.guestId }),
                    { qos: 1 },
                    () => { this.mqttClient?.end(); } // 回调中真正关闭
                );
            } else {
                if (this.mqttClient) this.mqttClient.end();
            }
        } catch (e) {
            if (this.mqttClient) this.mqttClient.end();
        }

        if (this.wsRelay) { try { this.wsRelay.close(); } catch (e) { } }
        this._connected = false;
    }
}
