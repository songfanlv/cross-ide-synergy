/**
 * Antigravity Share - VS Code 协同编辑扩展主模块 (v3 终极稳定版)
 *
 * 【v3 新增】
 * - 全局异常兜底：process.on uncaughtException / unhandledRejection
 * - Host 侧的 DocumentSync 同样受路径黑名单保护
 */

import * as vscode from 'vscode';
import { HostServer } from './network/HostServer';
import { GuestClient } from './network/GuestClient';
import { DocumentSync } from './editor/DocumentSync';

// ---- 全局实例 ----
let hostServer: HostServer | null = null;
let guestClient: GuestClient | null = null;
let documentSync: DocumentSync | null = null;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

/** 当前角色：host / guest / idle */
let currentRole: 'host' | 'guest' | 'idle' = 'idle';

/** 统一日志函数 */
function log(msg: string) {
    const time = new Date().toLocaleTimeString();
    outputChannel?.appendLine(`[${time}] ${msg}`);
}

export function activateMain(context: vscode.ExtensionContext, channel: vscode.OutputChannel) {
    outputChannel = channel;
    // 强制显示 Output Channel，方便用户查看这边的动态（新建、删除等操作）
    outputChannel.show(true);

    // ========== 全局异常兜底 ==========
    // 防止任意一个未捕获异常导致整个扩展宿主进程崩溃
    process.on('uncaughtException', (err) => {
        log(`[GLOBAL] ‼️ 未捕获异常（已拦截，扩展继续运行）: ${err.message}`);
        if (err.stack) log(`[GLOBAL] 堆栈: ${err.stack}`);
    });

    process.on('unhandledRejection', (reason: any) => {
        const msg = reason?.message || String(reason);
        log(`[GLOBAL] ‼️ 未处理的 Promise 拒绝（已拦截）: ${msg}`);
    });

    try {
        log('[Antigravity Share] 核心模块已接管控制权，扩展已激活(v3 终极稳定版)');

        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        statusBarItem.text = '$(broadcast) Share';
        statusBarItem.tooltip = '点击分享当前项目，开启跨网络协同编辑';
        statusBarItem.command = 'antigravity.share';
        statusBarItem.show();
        context.subscriptions.push(statusBarItem);

        const shareCmd = vscode.commands.registerCommand('antigravity.share', async () => {
            if (currentRole !== 'idle') {
                const action = await vscode.window.showWarningMessage('当前已有活跃连接，是否先断开？', '断开并重新分享', '取消');
                if (action === '断开并重新分享') await disconnectAll();
                else return;
            }
            await startHosting();
        });

        const joinCmd = vscode.commands.registerCommand('antigravity.join', async () => {
            if (currentRole !== 'idle') {
                const action = await vscode.window.showWarningMessage('当前已有活跃连接，是否先断开？', '断开并重新加入', '取消');
                if (action === '断开并重新加入') await disconnectAll();
                else return;
            }
            await joinHost();
        });

        const disconnectCmd = vscode.commands.registerCommand('antigravity.disconnect', async () => {
            log('[Command] 收到断开连接指令');
            await disconnectAll();
            vscode.window.showInformationMessage('已结束当前协同会话。');
        });

        context.subscriptions.push(shareCmd, joinCmd, disconnectCmd);
        log('[Antigravity Share] 命令注册成功');
    } catch (error) {
        log(`[Antigravity Share] 激活失败: ${error}`);
    }
}

/**
 * Host 模式：启动服务并创建分享码
 */
async function startHosting(): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
        vscode.window.showErrorMessage('请先打开一个工作区文件夹。');
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "正在开启协同编辑 (正在注册分享通道...)",
        cancellable: true
    }, async (progress, token) => {
        try {
            log('[Share] 正在开启协同中继服务器...');
            hostServer = new HostServer(log);
            documentSync = new DocumentSync(log);

            hostServer.onMessage = async (msg, _sender) => {
                try {
                    await documentSync?.handleMessage(msg);
                } catch (e: any) {
                    log(`[Share] 处理消息异常: ${e.message}`);
                }
            };
            documentSync.sendMessage = (msg) => {
                try {
                    hostServer?.sendToAll(JSON.stringify(msg));
                } catch (e: any) {
                    log(`[Share] 发送消息异常: ${e.message}`);
                }
            };

            hostServer.onClientConnected = async () => {
                log('[Share] ✅ 有新协作者加入。');
                // 延迟发送以确保 MQTT 中继通道在访客端完全就绪
                setTimeout(async () => {
                    log('[Share] 正在全量同步工作区文件内容...');
                    try {
                        await documentSync?.sendWorkspaceSync();
                        // 延迟 3 秒后下发当前活跃文件，确保客户端先处理完 workspace sync
                        setTimeout(() => {
                            documentSync?.syncActiveFile();
                        }, 3000);
                    } catch (e: any) {
                        log(`[Share] 同步工作区时发生错误: ${e.message}`);
                    }
                }, 2500);
                updateStatusBar();
            };
            hostServer.onClientDisconnected = () => updateStatusBar();

            const shareCode = await hostServer.start();

            if (token.isCancellationRequested) {
                log('[Share] 用户取消开启');
                await disconnectAll();
                return;
            }

            log(`[Share] 🚀 分享通道已就绪，当前专属分享码: ${shareCode}`);

            currentRole = 'host';
            documentSync.startListening();
            updateStatusBar();

            const items = ['📋 复制分享码'];

            const msg = `🚀 协同服务 (MQTT/WS) 已就绪！\n\n您的专属【分享码】为：${shareCode}\n（将此分享码发送给参与者，即可开启跨网络协同编辑）`;

            const action = await vscode.window.showInformationMessage(msg, { modal: true }, ...items);

            if (action?.includes('复制分享码')) {
                await vscode.env.clipboard.writeText(shareCode);
                vscode.window.showInformationMessage('✅ 分享码已复制到剪贴板！');
            }
        } catch (err: any) {
            log(`[Share] 异常中止: ${err.message}`);
            if (err.stack) log(`[Share] 错误堆栈:\n${err.stack}`);
            vscode.window.showErrorMessage(`开启协作失败: ${err.message}`);
            await disconnectAll();
        }
    });
}

/**
 * Guest 模式：加入协作
 */
async function joinHost(): Promise<void> {
    // 强制检查工作区情况
    if (!vscode.workspace.workspaceFolders?.length) {
        const action = await vscode.window.showErrorMessage(
            "【重要】您当前没有打开任何文件夹！\n\n为了接收 Host 同步的项目文件，您必须先打开一个本地空文件夹。",
            "立即打开文件夹",
            "取消"
        );
        if (action === "立即打开文件夹") {
            vscode.commands.executeCommand("vscode.openFolder");
            return;
        }
        return;
    }

    const shareCode = await vscode.window.showInputBox({
        prompt: '请输入主机提供的 6 位分享码',
        placeHolder: '例如：A1B2C3',
    });

    if (!shareCode) return;

    try {
        log(`[Join] 开始尝试加入分享码: ${shareCode}`);
        guestClient = new GuestClient(log);
        documentSync = new DocumentSync(log);

        guestClient.onMessage = async (msg) => {
            try {
                await documentSync?.handleMessage(msg);
            } catch (e: any) {
                log(`[Join] 处理消息异常: ${e.message}`);
            }
        };
        documentSync.sendMessage = (msg) => {
            try {
                guestClient?.send(msg);
            } catch (e: any) {
                log(`[Join] 发送消息异常: ${e.message}`);
            }
        };
        guestClient.onDisconnected = (reason) => {
            log(`[Join] 被动断开: ${reason}`);
            vscode.window.showWarningMessage(`⚠️ 与主机的连接已断开: ${reason}`);
            disconnectAll();
        };

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在连接中继服务并建立协作通道...',
            cancellable: true
        }, async (progress, token) => {
            token.onCancellationRequested(() => guestClient?.disconnect());
            await guestClient!.connect(shareCode);
        });

        currentRole = 'guest';
        documentSync.startListening();
        updateStatusBar();
        const connMode = guestClient?.mode === 'mqtt' ? 'MQTT 中继' : 'WebSocket 中继';
        log(`[Join] ✅ 连接成功，模式: ${connMode}`);
        vscode.window.showInformationMessage(`✅ 协同连接建立成功！\n当前模式: ${connMode}\n正在完成文件同步...`);

    } catch (err: any) {
        log(`[Join] 失败: ${err.message}`);
        if (err.stack) log(`[Join] 错误堆栈:\n${err.stack}`);
        vscode.window.showErrorMessage(`连接失败: ${err.message}`);
        await disconnectAll();
    }
}

function updateStatusBar(): void {
    if (!statusBarItem) return;
    if (currentRole === 'host') {
        const count = hostServer?.clientCount ?? 0;
        statusBarItem.text = `$(broadcast) 协同主机 (${count}人)`;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (currentRole === 'guest') {
        statusBarItem.text = `$(plug) 协同访客`;
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        statusBarItem.text = `$(broadcast) Share`;
        statusBarItem.backgroundColor = undefined;
    }
}

async function disconnectAll(): Promise<void> {
    log('[System] 强制注销协同资源...');
    try {
        if (currentRole === 'guest') {
            try {
                // 阅后即焚：关闭所有协同期间打开的文件窗口，避免残留干扰
                await vscode.commands.executeCommand('workbench.action.closeAllEditors');

                // [修复核心Bug 3]：真正的阅后即焚（物理删除）。清空下载的这个临时工作区间内的所有文件和文件夹。
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders && workspaceFolders.length > 0) {
                    const rootUri = workspaceFolders[0].uri;
                    const entries = await vscode.workspace.fs.readDirectory(rootUri);

                    for (const [name, type] of entries) {
                        const targetUri = vscode.Uri.joinPath(rootUri, name);
                        try {
                            // 递归删除工作区根目录下所有文件和文件夹，彻底不留痕
                            await vscode.workspace.fs.delete(targetUri, { recursive: true, useTrash: false });
                        } catch (delErr: any) {
                            log(`[System] 删除残留文件 ${name} 失败: ${delErr.message}`);
                        }
                    }
                    log('[System] 访客离线，已在硬盘上彻底销毁协同下载的代码 (真正的阅后即焚)');
                } else {
                    log('[System] 访客离线，未找到工作区，跳过清理');
                }
            } catch (e: any) {
                log(`[System] 阅后即焚执行异常: ${e.message}`);
            }
        }

        if (hostServer) { await hostServer.stop(); hostServer = null; }
        if (guestClient) { guestClient.disconnect(); guestClient = null; }
        if (documentSync) { documentSync.dispose(); documentSync = null; }
    } catch (e) { } finally {
        currentRole = 'idle';
        updateStatusBar();
        log('[System] 已恢复至待命状态');
    }
}

export function deactivate(): void {
    disconnectAll();
}
