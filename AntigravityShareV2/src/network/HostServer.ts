/**
 * HostServer - 协同编辑的主机端服务器 (v3.0 纯 JS 稳定版)
 * 连接方式：MQTT 中继 (主) + WebSocket 中继 (备)
 * 
 * 【v3.0 核心变更】
 * - 彻底移除 node-datachannel (WebRTC) 原生模块，根治段错误崩溃
 * - 彻底移除 localtunnel，消除不稳定穿透导致的隐形异常
 * - 简化连接逻辑：Guest 加入后直接通过 MQTT 中继通信
 */

import * as vscode from 'vscode';
import * as mqtt from 'mqtt';
import WebSocket from 'ws';
import { connectWithFallback, formatError } from './brokers';
import { ShareMessage, MessageType, NotificationMessage } from './protocol';

/** 客户端连接通道类型 */
type ChannelMode = 'mqtt' | 'ws';

/** 客户端信息 */
interface ClientInfo {
    mode: ChannelMode;
    lastHeartbeat: number;
}

export class HostServer {
    private mqttClient: mqtt.MqttClient | null = null;
    private wsRelay: WebSocket | null = null;
    private shareCode: string = '';

    /** 已连接的客户端列表 */
    private clients: Map<string, ClientInfo> = new Map();

    /** 心跳保活定时器 */
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    /** 是否正在主动停止 */
    private isStopping: boolean = false;

    private log: (msg: string) => void;

    public onMessage: ((msg: ShareMessage, senderId: string) => void) | null = null;
    public onClientConnected: ((clientCount: number) => void) | null = null;
    public onClientDisconnected: ((clientCount: number) => void) | null = null;

    constructor(logFn: (msg: string) => void) {
        this.log = logFn;
    }

    get clientCount(): number {
        return this.clients.size;
    }

    async start(): Promise<string> {
        this.shareCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        this.isStopping = false;
        this.log(`[Host] 正在开启协同服务 (v3.0 纯 JS 架构)...`);

        // ① MQTT Broker 连接
        const { client, brokerName } = await connectWithFallback(this.log);
        this.mqttClient = client;

        this.log(`[Host] ✅ MQTT 服务器已连接 (${brokerName})，分享码: ${this.shareCode}`);

        // 注册 MQTT 事件
        this.setupMqttMonitoring();

        this.mqttClient.on('message', (topic: string, message: Buffer) => {
            try {
                const payload = JSON.parse(message.toString());
                const parts = topic.split('/');

                if (!topic.endsWith('/keepalive') && !topic.includes('/data/')) {
                    this.log(`[Host] 📩 收到指令: ${topic.split('/').slice(3).join('/')}`);
                }

                // 各类来自访客的消息均视为心跳活跃
                if (topic.includes('/data/host/') || topic.endsWith('/keepalive') || topic.endsWith('/leave') || topic.endsWith('/join')) {
                    const guestId = payload.id || payload.guestId || parts[parts.length - 1];
                    if (guestId && this.clients.has(guestId)) {
                        this.clients.get(guestId)!.lastHeartbeat = Date.now();
                    }
                }

                if (topic.endsWith('/join')) {
                    this.log(`[Host] 收到访客 join 请求: ${payload.guestId}`);
                    this.handleGuestJoin(payload.guestId);
                    return;
                }

                if (topic.endsWith('/leave')) {
                    this.log(`[Host] 收到访客 leave 离线通知: ${payload.guestId}`);
                    this.removeClient(payload.guestId);
                    return;
                }

                // MQTT 数据（访客 → 主机）
                if (topic.includes('/data/host/')) {
                    const guestId = parts[parts.length - 1];
                    this.handleRelayData(guestId, payload);
                    return;
                }
            } catch (err: any) {
                this.log(`[Host] ❌ 处理 MQTT 消息失败: ${formatError(err)}`);
            }
        });

        // 订阅必要通道
        this.mqttClient.subscribe(`antigravity/share/${this.shareCode}/join`, { qos: 1 });
        this.mqttClient.subscribe(`antigravity/share/${this.shareCode}/leave`, { qos: 1 });
        this.mqttClient.subscribe(`antigravity/share/${this.shareCode}/data/host/#`, { qos: 1 });
        // 订阅访客发来的心跳包
        this.mqttClient.subscribe(`antigravity/share/${this.shareCode}/keepalive`, { qos: 0 });

        // 启动心跳
        this.startHeartbeat();

        // ② 尝试连接 WebSocket 中继 (备选)
        this.tryConnectWsRelay();

        return this.shareCode;
    }

    private startHeartbeat() {
        this.heartbeatTimer = setInterval(() => {
            const now = Date.now();

            // 1. 发送自己的保活
            if (this.mqttClient?.connected) {
                this.mqttClient.publish(
                    `antigravity/share/${this.shareCode}/keepalive`,
                    JSON.stringify({ ts: now, role: 'host' }),
                    { qos: 0 }
                );
            }

            // 2. 检测剔除掉线的 Guest (60秒无音讯，放宽限制，容忍全量同步阶段的心跳拥堵)
            for (const [guestId, info] of this.clients.entries()) {
                if (now - info.lastHeartbeat > 60000) {
                    this.log(`[Host] 访客 ${guestId} 心跳超时(已失联>60s)，由于长时间阻塞主线程，主动踢出此客户端`);
                    this.removeClient(guestId);
                }
            }
        }, 10000);
    }

    private setupMqttMonitoring() {
        if (!this.mqttClient) return;

        this.mqttClient.on('close', () => {
            if (!this.isStopping) this.log(`[Host] ⚠️ MQTT 连接断开`);
        });

        this.mqttClient.on('connect', () => {
            if (this.isStopping) return;
            this.log(`[Host] ✅ MQTT 重连成功`);
            this.mqttClient?.subscribe(`antigravity/share/${this.shareCode}/join`, { qos: 1 });
            this.mqttClient?.subscribe(`antigravity/share/${this.shareCode}/leave`, { qos: 1 });
            this.mqttClient?.subscribe(`antigravity/share/${this.shareCode}/data/host/#`, { qos: 1 });
            this.mqttClient?.subscribe(`antigravity/share/${this.shareCode}/keepalive`, { qos: 0 });
        });

        this.mqttClient.on('error', (err: any) => {
            if (!this.isStopping) this.log(`[Host] ❌ MQTT 错误: ${formatError(err)}`);
        });
    }

    private tryConnectWsRelay() {
        const relayUrl = vscode.workspace.getConfiguration('antigravity').get<string>('relayUrl', '');
        if (!relayUrl) return;

        try {
            const wsUrl = relayUrl.replace(/^http/, 'ws') + `/relay/${this.shareCode}?role=host`;
            this.wsRelay = new WebSocket(wsUrl);

            this.wsRelay.on('open', () => this.log(`[Host] ✅ WebSocket 中继已启用`));
            this.wsRelay.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.type === 'guest_joined') {
                        if (!this.clients.has(msg.guestId)) {
                            this.log(`[Host] 访客 ${msg.guestId} 通过 WS 加入`);
                            this.addClient(msg.guestId, 'ws');
                        }
                    } else if (msg.type === 'guest_data') {
                        this.handleRelayData(msg.guestId, msg.payload);
                    } else if (msg.type === 'guest_left') {
                        if (this.clients.get(msg.guestId)?.mode === 'ws') this.removeClient(msg.guestId);
                    }
                } catch (e) { }
            });
            this.wsRelay.on('error', (e) => this.log(`[Host] WS 中继错误: ${formatError(e)}`));
        } catch (e) { }
    }

    private handleGuestJoin(guestId: string) {
        if (this.clients.has(guestId)) return;
        this.log(`[Host] 访客 ${guestId} 加入，激活 MQTT 中继`);
        this.addClient(guestId, 'mqtt');

        // 通知访客启用连接
        this.mqttClient?.publish(
            `antigravity/share/${this.shareCode}/guest/${guestId}/relay`,
            JSON.stringify({ mode: 'mqtt' }),
            { qos: 1 }
        );
    }

    private handleRelayData(guestId: string, payload: any) {
        try {
            this.onMessage?.(payload, guestId);
            this.broadcast(JSON.stringify(payload), guestId);
        } catch (e) { }
    }

    private addClient(guestId: string, mode: ChannelMode) {
        this.clients.set(guestId, { mode, lastHeartbeat: Date.now() });
        const notification: NotificationMessage = {
            type: MessageType.NOTIFICATION,
            message: `协同者 ${guestId.substring(0, 4)} 已加入 (${mode})`
        };
        this.broadcast(JSON.stringify(notification), null);
        this.onClientConnected?.(this.clients.size);
    }

    private removeClient(guestId: string) {
        if (!this.clients.has(guestId)) return;
        this.clients.delete(guestId);
        this.log(`[Host] 访客 ${guestId} 已离开，剩余: ${this.clients.size}`);
        this.onClientDisconnected?.(this.clients.size);
    }

    broadcast(data: string, excludeId: string | null): void {
        for (const [id, info] of this.clients.entries()) {
            if (id === excludeId) continue;
            try {
                if (info.mode === 'mqtt') {
                    this.mqttClient?.publish(`antigravity/share/${this.shareCode}/data/${id}`, data, { qos: 1 });
                } else if (info.mode === 'ws' && this.wsRelay?.readyState === WebSocket.OPEN) {
                    this.wsRelay.send(JSON.stringify({ targetId: id, payload: JSON.parse(data) }));
                }
            } catch (e) { }
        }
    }

    sendToAll(data: string): void {
        this.broadcast(data, null);
    }

    async stop(): Promise<void> {
        this.isStopping = true;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

        if (this.wsRelay) { try { this.wsRelay.close(); } catch (e) { } }
        if (this.mqttClient) { this.mqttClient.end(); }

        this.clients.clear();
        this.log('[Host] 服务端已安全停止');
    }
}
