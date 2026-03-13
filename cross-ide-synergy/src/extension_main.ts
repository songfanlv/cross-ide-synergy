import * as vscode from 'vscode';
import { HostServer } from './network/HostServer';
import { GuestClient } from './network/GuestClient';
import { DocumentSync } from './editor/DocumentSync';
import { SidecarManager } from './network/SidecarManager';

let hostServer: HostServer | null = null;
let guestClient: GuestClient | null = null;
let documentSync: DocumentSync | null = null;
let sidecarManager: SidecarManager | null = null;
let outputChannel: vscode.OutputChannel;

let statusShare: vscode.StatusBarItem;
let statusJoin: vscode.StatusBarItem;
let statusDisconnect: vscode.StatusBarItem;
let currentRole: 'host' | 'guest' | 'idle' = 'idle';

function log(msg: string): void {
    const time = new Date().toLocaleTimeString();
    outputChannel?.appendLine(`[${time}] ${msg}`);
}

export async function activateMain(context: vscode.ExtensionContext, channel: vscode.OutputChannel) {
    outputChannel = channel;
    outputChannel.show(true);

    statusShare = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 103);
    statusShare.text = '$(broadcast) Share';
    statusShare.tooltip = 'Share project as host';
    statusShare.command = 'crosside.share';
    statusShare.show();

    statusJoin = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 102);
    statusJoin.text = '$(plug) Join';
    statusJoin.tooltip = 'Join collaboration as guest';
    statusJoin.command = 'crosside.join';
    statusJoin.show();

    statusDisconnect = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    statusDisconnect.text = '$(debug-disconnect) Stop';
    statusDisconnect.tooltip = 'Disconnect current collaboration session';
    statusDisconnect.command = 'crosside.disconnect';
    statusDisconnect.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');

    context.subscriptions.push(statusShare, statusJoin, statusDisconnect);
    updateStatusBar();

    try {
        sidecarManager = new SidecarManager(log);
        void sidecarManager.ensureStarted(context).catch((err) => {
            log(`[Sidecar] Startup failed: ${err.message}`);
        });

        const shareCmd = vscode.commands.registerCommand('crosside.share', async () => {
            if (currentRole !== 'idle') {
                const action = await vscode.window.showWarningMessage(
                    'A collaboration session is already active. Disconnect first?',
                    'Disconnect and Share',
                    'Cancel'
                );
                if (action !== 'Disconnect and Share') {
                    return;
                }
                await disconnectAll();
            }

            await startHosting();
        });

        const joinCmd = vscode.commands.registerCommand('crosside.join', async () => {
            if (currentRole !== 'idle') {
                const action = await vscode.window.showWarningMessage(
                    'A collaboration session is already active. Disconnect first?',
                    'Disconnect and Join',
                    'Cancel'
                );
                if (action !== 'Disconnect and Join') {
                    return;
                }
                await disconnectAll();
            }

            await joinHost();
        });

        const disconnectCmd = vscode.commands.registerCommand('crosside.disconnect', async () => {
            await disconnectAll();
            vscode.window.showInformationMessage('Collaboration session closed.');
        });

        context.subscriptions.push(shareCmd, joinCmd, disconnectCmd);
        log('[Cross-IDE Synergy] Commands registered');
    } catch (error: any) {
        log(`[Cross-IDE Synergy] Activation failed: ${error.message ?? String(error)}`);
    }
}

async function startHosting(): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showErrorMessage('Open a workspace folder before starting collaboration.');
        return;
    }

    if (!sidecarManager) {
        vscode.window.showErrorMessage('Sidecar is not initialized.');
        return;
    }
    const manager = sidecarManager;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Starting collaboration session...',
            cancellable: true,
        },
        async (_progress, token) => {
            try {
                hostServer = new HostServer(log, manager);
                documentSync = new DocumentSync(log);

                hostServer.onMessage = async (msg) => {
                    await documentSync?.handleMessage(msg);
                };

                documentSync.sendMessage = (msg) => {
                    hostServer?.sendToAll(JSON.stringify(msg));
                };

                hostServer.onClientConnected = async () => {
                    log('[Share] Guest joined, starting workspace sync');
                    setTimeout(async () => {
                        try {
                            await documentSync?.sendWorkspaceSync();
                            setTimeout(() => {
                                documentSync?.syncActiveFile();
                            }, 3000);
                        } catch (err: any) {
                            log(`[Share] Workspace sync failed: ${err.message}`);
                        }
                    }, 2500);
                    updateStatusBar();
                };

                hostServer.onClientDisconnected = () => {
                    updateStatusBar();
                };

                const shareCode = await hostServer.start();

                if (token.isCancellationRequested) {
                    await disconnectAll();
                    return;
                }

                currentRole = 'host';
                documentSync.startListening();
                updateStatusBar();

                const action = await vscode.window.showInformationMessage(
                    `Share code: ${shareCode}`,
                    { modal: true },
                    'Copy Share Code'
                );

                if (action === 'Copy Share Code') {
                    await vscode.env.clipboard.writeText(shareCode);
                    vscode.window.showInformationMessage('Share code copied to clipboard.');
                }
            } catch (err: any) {
                log(`[Share] Failed: ${err.message}`);
                if (err.stack) {
                    log(err.stack);
                }
                vscode.window.showErrorMessage(`Failed to start collaboration: ${err.message}`);
                await disconnectAll();
            }
        }
    );
}

async function joinHost(): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
        const action = await vscode.window.showErrorMessage(
            'Open an empty workspace folder before joining so synced files have a safe destination.',
            'Open Folder',
            'Cancel'
        );
        if (action === 'Open Folder') {
            await vscode.commands.executeCommand('vscode.openFolder');
        }
        return;
    }

    if (!sidecarManager) {
        vscode.window.showErrorMessage('Sidecar is not initialized.');
        return;
    }
    const manager = sidecarManager;

    const shareCode = await vscode.window.showInputBox({
        prompt: 'Enter the 6-character share code from the host',
        placeHolder: 'A1B2C3',
    });

    if (!shareCode) {
        return;
    }

    try {
        guestClient = new GuestClient(log, manager);
        documentSync = new DocumentSync(log);

        guestClient.onMessage = async (msg) => {
            await documentSync?.handleMessage(msg);
        };

        documentSync.sendMessage = (msg) => {
            guestClient?.send(msg);
        };

        guestClient.onDisconnected = (reason) => {
            log(`[Join] Disconnected: ${reason}`);
            void disconnectAll();
            void vscode.window.showWarningMessage(`Disconnected from host: ${reason}`);
        };

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Joining collaboration session...',
                cancellable: true,
            },
            async (_progress, token) => {
                token.onCancellationRequested(() => {
                    void guestClient?.disconnect();
                });
                await guestClient!.connect(shareCode);
            }
        );

        currentRole = 'guest';
        documentSync.startListening();
        updateStatusBar();
        vscode.window.showInformationMessage('Connected. Waiting for workspace sync...');
    } catch (err: any) {
        log(`[Join] Failed: ${err.message}`);
        if (err.stack) {
            log(err.stack);
        }
        vscode.window.showErrorMessage(`Failed to join collaboration: ${err.message}`);
        await disconnectAll();
    }
}

function updateStatusBar(): void {
    if (!statusShare || !statusJoin || !statusDisconnect) {
        return;
    }

    if (currentRole === 'host') {
        statusShare.text = `$(broadcast) Host (${hostServer?.clientCount ?? 0})`;
        statusShare.show();
        statusJoin.hide();
        statusDisconnect.show();
        return;
    }

    if (currentRole === 'guest') {
        statusShare.hide();
        statusJoin.text = '$(plug) Guest';
        statusJoin.show();
        statusDisconnect.show();
        return;
    }

    statusShare.text = '$(broadcast) Share';
    statusShare.show();
    statusJoin.text = '$(plug) Join';
    statusJoin.show();
    statusDisconnect.hide();
}

async function disconnectAll(): Promise<void> {
    log('[System] Releasing collaboration resources');

    try {
        if (currentRole === 'guest') {
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            log('[System] Guest disconnected without deleting workspace files');
        }

        if (hostServer) {
            await hostServer.stop();
            hostServer = null;
        }

        if (guestClient) {
            await guestClient.disconnect();
            guestClient = null;
        }

        if (documentSync) {
            documentSync.dispose();
            documentSync = null;
        }
    } catch (err: any) {
        log(`[System] Disconnect failed: ${err.message}`);
    } finally {
        currentRole = 'idle';
        updateStatusBar();
    }
}

export function deactivate(): void {
    const manager = sidecarManager;
    sidecarManager = null;
    void disconnectAll().finally(() => {
        manager?.stop();
    });
}
