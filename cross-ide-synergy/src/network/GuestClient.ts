/**
 * GuestClient - 协同编辑的访客端客户端 (v3.0 纯 JS 稳定版)
 * 连接方式：MQTT 中继 (主) + WebSocket 中继 (备)
 * 
 * 【v3.0 核心变更】
 * - 移除 WebRTC 逻辑，避免原生模块崩溃
 * - 移除 LocalTunnel 逻辑
 * - 简化连接流程：直接进入 MQTT 握手
 */

import { ShareMessage } from './protocol';
import { SidecarManager } from './SidecarManager';

export class GuestClient {
    private shareCode: string = '';
    private _connected: boolean = false;
    private log: (msg: string) => void;
    private sidecar: SidecarManager;

    public onMessage: ((msg: ShareMessage) => void) | null = null;
    public onConnected: (() => void) | null = null;
    public onDisconnected: ((reason: string) => void) | null = null;

    constructor(logFn: (msg: string) => void, sidecar: SidecarManager) {
        this.log = logFn;
        this.sidecar = sidecar;
    }

    get connected(): boolean { return this._connected; }
    get mode(): string { return 'sidecar'; }

    async connect(shareCode: string): Promise<void> {
        this.shareCode = shareCode.trim().toUpperCase();
        this.log(`[Guest] 正在通过 Sidecar 核心连接: ${this.shareCode}...`);

        try {
            await this.sidecar.callRpc('start_guest', { shareCode: this.shareCode });
            this._connected = true;
            this.log(`[Guest] ✅ 代理连接成功`);

            // 监听来自 Sidecar 的协议消息
            this.sidecar.onMessage((msg) => {
                this.onMessage?.(msg);
            });

            this.onConnected?.();
        } catch (err: any) {
            this.log(`[Guest] ❌ 无法通过 Sidecar 建立会话: ${err.message}`);
            throw err;
        }
    }

    send(msg: ShareMessage): void {
        if (!this._connected) return;
        this.sidecar.sendMessage(msg);
    }

    async disconnect(): Promise<void> {
        if (!this._connected) return;
        try {
            await this.sidecar.callRpc('stop_session');
        } catch (e) { }
        this._connected = false;
        this.log('[Guest] 代理会话已结束');
    }
}
