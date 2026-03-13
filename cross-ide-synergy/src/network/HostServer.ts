import { ShareMessage } from './protocol';
import { SidecarManager } from './SidecarManager';

type SessionControlMessage = {
    type: 'session_event';
    event: 'join' | 'leave';
    guestId: string;
};

export class HostServer {
    private shareCode = '';
    private readonly log: (msg: string) => void;
    private readonly sidecar: SidecarManager;
    private _clientCount = 0;
    private readonly connectedGuests = new Set<string>();

    public onMessage: ((msg: ShareMessage, senderId: string) => void) | null = null;
    public onClientConnected: ((clientCount: number) => void) | null = null;
    public onClientDisconnected: ((clientCount: number) => void) | null = null;

    constructor(logFn: (msg: string) => void, sidecar: SidecarManager) {
        this.log = logFn;
        this.sidecar = sidecar;
    }

    get clientCount(): number {
        return this._clientCount;
    }

    async start(): Promise<string> {
        this.log('[Host] Starting collaboration via Sidecar');

        try {
            const result = await this.sidecar.callRpc('start_host', {});
            this.shareCode = result.shareCode;
            this.connectedGuests.clear();
            this._clientCount = 0;

            this.sidecar.onMessage((msg) => {
                if (this.isSessionControlMessage(msg)) {
                    this.handleSessionEvent(msg);
                    return;
                }

                this.onMessage?.(msg, msg.senderId || 'unknown');
            });

            this.log(`[Host] Session ready with share code ${this.shareCode}`);
            return this.shareCode;
        } catch (err: any) {
            this.log(`[Host] Failed to start session: ${err.message}`);
            throw err;
        }
    }

    broadcast(data: string, _excludeId: string | null): void {
        try {
            const msg = JSON.parse(data);
            this.sidecar.sendMessage(msg);
        } catch {
            // Ignore invalid payloads.
        }
    }

    sendToAll(data: string): void {
        this.broadcast(data, null);
    }

    async stop(): Promise<void> {
        this.connectedGuests.clear();
        this._clientCount = 0;
        try {
            await this.sidecar.callRpc('stop_session');
        } catch {
            // Ignore shutdown errors.
        }
        this.log('[Host] Session stopped');
    }

    private isSessionControlMessage(msg: any): msg is SessionControlMessage {
        return (
            msg &&
            msg.type === 'session_event' &&
            (msg.event === 'join' || msg.event === 'leave') &&
            typeof msg.guestId === 'string'
        );
    }

    private handleSessionEvent(msg: SessionControlMessage): void {
        if (msg.event === 'join') {
            if (this.connectedGuests.has(msg.guestId)) {
                return;
            }
            this.connectedGuests.add(msg.guestId);
            this._clientCount = this.connectedGuests.size;
            this.log(`[Host] Guest joined: ${msg.guestId}`);
            this.onClientConnected?.(this._clientCount);
            return;
        }

        if (!this.connectedGuests.delete(msg.guestId)) {
            return;
        }
        this._clientCount = this.connectedGuests.size;
        this.log(`[Host] Guest left: ${msg.guestId}`);
        this.onClientDisconnected?.(this._clientCount);
    }
}
