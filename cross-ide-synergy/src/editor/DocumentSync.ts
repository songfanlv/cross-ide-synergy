/**
 * DocumentSync - 文档同步核心模块 (v3 终极稳定版)
 *
 * 【核心防死循环策略】
 * 1. suppressedPaths: 正在被远端操作的文件路径集合，在此集合中的路径产生的
 *    onDidChangeTextDocument 事件一律丢弃，绝不向远端广播
 * 2. isWorkspaceSyncing: 全量同步进行中的全局锁，一切本地变更事件都不向外广播
 * 3. messageQueue: 消息串行化处理队列，防止并发 applyEdit 造成冲突
 * 4. senderId: 过滤自己发出又被 Host broadcast 回来的消息
 */

import * as vscode from 'vscode';
import {
    ShareMessage,
    MessageType,
    ChangeMessage,
    TextChange,
    FullSyncMessage,
    RequestSyncMessage,
    WorkspaceSyncMessage,
    OpenFileMessage,
    CursorMessage,
    FileEventMessage,
} from '../network/protocol';

export class DocumentSync {
    // ========== 防死循环核心锁 ==========

    /** 正在被远端操作的文件路径集合 —— 在此集合里的路径产生的文档变更事件一律丢弃 */
    private suppressedPaths: Set<string> = new Set();

    /** 全量同步进行中的全局锁 */
    private isWorkspaceSyncing: boolean = false;

    /** 如影随形锁（防止打开文件触发 onDidChangeActiveTextEditor 回弹） */
    private openFileLock: boolean = false;

    // ========== 消息队列串行化 ==========

    /** 待处理消息队列 */
    private messageQueue: ShareMessage[] = [];
    /** 是否正在处理消息 */
    private isProcessing: boolean = false;

    private log: (msg: string) => void = console.log;

    // ========== 日志控制 ==========
    /** 记录最近一次打印修改日志的时间（节流防刷屏） filePath -> timestamp */
    private changeLogTimers: Map<string, number> = new Map();

    // ========== 光标渲染管理 ==========
    private decorationTypes: Map<string, vscode.TextEditorDecorationType> = new Map();
    /** 防抖计时器 */
    private cursorSendTimer: ReturnType<typeof setTimeout> | null = null;
    /** 选区回收计时器 (若对方无操作则一段时间后隐去) */
    private cursorHideTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

    // ========== 其他 ==========

    private disposables: vscode.Disposable[] = [];

    /** 发送消息的回调函数 */
    public sendMessage: ((msg: ShareMessage) => void) | null = null;

    /** 唯一标识符，用来在广播中过滤自己发的消息 */
    public senderId: string;

    constructor(logFn: (msg: string) => void) {
        this.log = logFn;
        this.senderId = Math.random().toString(36).substring(2, 10);
    }

    /**
     * 启动监听：监听文本变更和活跃编辑器切换
     */
    startListening(): void {
        console.log('[Sync] 核心监听器已启动 (v3 终极稳定版)');

        // 1. 监听文本变更
        const changeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
            // 全局锁：全量同步期间丢弃一切
            if (this.isWorkspaceSyncing) return;
            if (event.document.uri.scheme !== 'file' || event.contentChanges.length === 0) return;

            const filePath = this.getRelativePath(event.document.uri);
            if (!filePath) return;

            // 路径黑名单：正在被远端操作的文件路径，一律丢弃
            if (this.suppressedPaths.has(filePath)) {
                return;
            }

            const changes: TextChange[] = event.contentChanges.map((change) => ({
                startLine: change.range.start.line,
                startChar: change.range.start.character,
                endLine: change.range.end.line,
                endChar: change.range.end.character,
                text: change.text,
            }));

            const msg: ChangeMessage = {
                type: MessageType.CHANGE,
                filePath,
                changes,
                senderId: this.senderId,
            };

            this.sendMessage?.(msg);
        });

        // 2. 监听活跃编辑器切换（实现"如影随形"）
        // [修复团队协作]：不再对外广播自己的活跃文件，除非后续支持点击头像跟随等主动操作
        // 对于团队协作，保持各自的视角更关键，所以屏蔽此自动广播。
        const activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (this.openFileLock || this.isWorkspaceSyncing) return;
            if (!editor || editor.document.uri.scheme !== 'file') return;

            const filePath = this.getRelativePath(editor.document.uri);
            if (!filePath) return;

            const msg: OpenFileMessage = {
                type: MessageType.OPEN_FILE,
                filePath
            };
            this.sendMessage?.(msg);
        });

        // 3. 监听光标与选区变化 (新功能)
        const selectionDisposable = vscode.window.onDidChangeTextEditorSelection((event) => {
            if (this.isWorkspaceSyncing) return;
            if (event.textEditor.document.uri.scheme !== 'file') return;

            const filePath = this.getRelativePath(event.textEditor.document.uri);
            if (!filePath) return;

            // 防抖，避免选区拖拽时产生海量消息
            if (this.cursorSendTimer) clearTimeout(this.cursorSendTimer);
            this.cursorSendTimer = setTimeout(() => {
                const selections = event.selections.map(sel => ({
                    anchorLine: sel.anchor.line,
                    anchorChar: sel.anchor.character,
                    activeLine: sel.active.line,
                    activeChar: sel.active.character
                }));

                const msg: CursorMessage = {
                    type: MessageType.CURSOR,
                    filePath,
                    selections,
                    senderId: this.senderId
                };
                this.sendMessage?.(msg);
            }, 100); // 100ms 刷新率
        });

        // 4. 监听文件新建
        const createFileDisposable = vscode.workspace.onDidCreateFiles((event) => {
            if (this.isWorkspaceSyncing) return;
            for (const file of event.files) {
                const filePath = this.getRelativePath(file);
                if (!filePath) continue;

                if (this.suppressedPaths.has(filePath)) continue;

                (async () => {
                    try {
                        const stat = await vscode.workspace.fs.stat(file);
                        const isDir = stat.type === vscode.FileType.Directory;
                        this.log(`[Sync] 📝 您新建了${isDir ? '文件夹' : '文件'}: ${filePath}`);
                        const msg: FileEventMessage = {
                            type: MessageType.FILE_EVENT,
                            eventType: 'create',
                            filePath,
                            isDir,
                            senderId: this.senderId
                        };
                        this.sendMessage?.(msg);
                    } catch (err: any) {
                        this.log(`[Sync] ❌ 无法获取新建文件状态: ${err.message}`);
                    }
                })();
            }
        });

        // 5. 监听文件删除
        const deleteFileDisposable = vscode.workspace.onDidDeleteFiles((event) => {
            if (this.isWorkspaceSyncing) return;
            for (const file of event.files) {
                const filePath = this.getRelativePath(file);
                if (!filePath) continue;

                if (this.suppressedPaths.has(filePath)) continue;

                this.log(`[Sync] 🗑️ 您删除了文件/文件夹: ${filePath}`);
                const msg: FileEventMessage = {
                    type: MessageType.FILE_EVENT,
                    eventType: 'delete',
                    filePath,
                    isDir: false, // 删除时不严格区分，统一按路径递归删除
                    senderId: this.senderId
                };
                this.sendMessage?.(msg);
            }
        });

        // 6. 监听文件重命名 (或移动)
        const renameFileDisposable = vscode.workspace.onDidRenameFiles((event) => {
            if (this.isWorkspaceSyncing) return;
            for (const file of event.files) {
                const oldFilePath = this.getRelativePath(file.oldUri);
                const newFilePath = this.getRelativePath(file.newUri);
                if (!oldFilePath || !newFilePath) continue;

                // 若旧路径在黑名单中，也忽略（可能是远端发起的重命名）
                if (this.suppressedPaths.has(oldFilePath) || this.suppressedPaths.has(newFilePath)) {
                    continue;
                }

                (async () => {
                    try {
                        const stat = await vscode.workspace.fs.stat(file.newUri);
                        const isDir = stat.type === vscode.FileType.Directory;
                        this.log(`[Sync] 🔄 您重命名了${isDir ? '文件夹' : '文件'}: ${oldFilePath} -> ${newFilePath}`);

                        const msg: FileEventMessage = {
                            type: MessageType.FILE_EVENT,
                            eventType: 'rename',
                            filePath: oldFilePath,
                            newFilePath: newFilePath,
                            isDir,
                            senderId: this.senderId
                        };
                        this.sendMessage?.(msg);
                    } catch (err: any) {
                        this.log(`[Sync] ❌ 无法获取重命名后文件状态: ${err.message}`);
                    }
                })();
            }
        });

        this.disposables.push(
            changeDisposable,
            activeEditorDisposable,
            selectionDisposable,
            createFileDisposable,
            deleteFileDisposable,
            renameFileDisposable
        );
    }

    /**
     * 处理收到的远端消息（入口：先入队，串行处理）
     */
    async handleMessage(msg: ShareMessage): Promise<void> {
        this.messageQueue.push(msg);
        if (!this.isProcessing) {
            await this.processQueue();
        }
    }

    /**
     * 串行处理消息队列
     */
    private async processQueue(): Promise<void> {
        if (this.isProcessing) return;
        this.isProcessing = true;

        try {
            while (this.messageQueue.length > 0) {
                const msg = this.messageQueue.shift()!;
                try {
                    // 为单条消息处理添加 5 秒超时保护，防止损坏消息死锁队列
                    await Promise.race([
                        this.dispatchMessage(msg),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('消息处理超时')), 5000))
                    ]);
                } catch (err: any) {
                    this.log(`[Sync] ❌ 处理消息出错: ${err.message}`);
                }
            }
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * 实际分发消息
     */
    private async dispatchMessage(msg: ShareMessage): Promise<void> {
        switch (msg.type) {
            case MessageType.CHANGE:
                await this.applyRemoteChange(msg);
                break;
            case MessageType.FULL_SYNC:
                await this.applyFullSync(msg);
                break;
            case MessageType.REQUEST_SYNC:
                await this.handleSyncRequest(msg);
                break;
            case MessageType.WORKSPACE_SYNC:
                await this.applyWorkspaceSync(msg);
                break;
            case MessageType.OPEN_FILE:
                await this.applyRemoteOpenFile(msg);
                break;
            case MessageType.CURSOR:
                this.applyRemoteCursor(msg);
                break;
            case MessageType.FILE_EVENT:
                await this.applyRemoteFileEvent(msg);
                break;
            case MessageType.NOTIFICATION:
                vscode.window.showInformationMessage(`🤝 ${msg.message}`);
                break;
        }
    }

    // ========== 路径黑名单管理 ==========

    /** 将路径加入黑名单（期间该路径的 onDidChange 事件不会触发外发广播） */
    private suppressPath(filePath: string, durationMs: number = 3000): void {
        this.suppressedPaths.add(filePath);
        setTimeout(() => {
            this.suppressedPaths.delete(filePath);
        }, durationMs);
    }

    // ========== 文件打开提示 (原如影随形) ==========

    /**
     * 处理远程打开文件事件（仅在状态栏或输出提示，不再强制跳转窗口）
     */
    private async applyRemoteOpenFile(msg: OpenFileMessage): Promise<void> {
        // [修复团队协作] 当接收到对方打开文件的消息时，仅在底部状态栏短暂提示
        // 从而不在用户修改其他文件时，强行抢夺其窗口焦点。
        vscode.window.setStatusBarMessage(`👥 协作者正在查看: ${msg.filePath}`, 3000);
        this.log(`[Sync] 👁️ 协作者正在查看文件: ${msg.filePath}`);
    }

    // ========== 远程文件系统事件 (新建/删除/重命名) ==========

    private async applyRemoteFileEvent(msg: FileEventMessage): Promise<void> {
        if (msg.senderId === this.senderId) return;

        const fileUri = this.resolveFilePath(msg.filePath);
        if (!fileUri) return;

        const uidStr = msg.senderId.substring(0, 4);

        // 锁定路径，防止被本地 OnDid 触发死循环
        this.suppressPath(msg.filePath, 5000);
        if (msg.newFilePath) {
            this.suppressPath(msg.newFilePath, 5000);
        }

        try {
            if (msg.eventType === 'create') {
                this.log(`[Sync] 📝 协作者 (ID: ${uidStr}) 新建了${msg.isDir ? '文件夹' : '文件'}: ${msg.filePath}`);

                // 确保父目录存在
                const dirUri = vscode.Uri.joinPath(fileUri, '..');
                await vscode.workspace.fs.createDirectory(dirUri);

                if (msg.isDir) {
                    await vscode.workspace.fs.createDirectory(fileUri);
                } else {
                    // 仅创建空文件，后续若有全文或文本写入将通过 change 触发
                    await vscode.workspace.fs.writeFile(fileUri, new Uint8Array());
                }
            } else if (msg.eventType === 'delete') {
                this.log(`[Sync] 🗑️ 协作者 (ID: ${uidStr}) 删除了文件/文件夹: ${msg.filePath}`);
                try {
                    await vscode.workspace.fs.delete(fileUri, { recursive: true, useTrash: false });
                } catch (err: any) {
                    if (err.code !== 'FileNotFound') {
                        this.log(`[Sync] ⚠️ 删除操作可能未完全成功: ${err.message}`);
                    }
                }
            } else if (msg.eventType === 'rename' && msg.newFilePath) {
                const newFileUri = this.resolveFilePath(msg.newFilePath);
                if (newFileUri) {
                    this.log(`[Sync] 🔄 协作者 (ID: ${uidStr}) 重命名了${msg.isDir ? '文件夹' : '文件'}: ${msg.filePath} -> ${msg.newFilePath}`);

                    const newDirUri = vscode.Uri.joinPath(newFileUri, '..');
                    await vscode.workspace.fs.createDirectory(newDirUri);

                    await vscode.workspace.fs.rename(fileUri, newFileUri, { overwrite: true });
                }
            }
        } catch (err: any) {
            this.log(`[Sync] ❌ 应用远端文件事件(${msg.eventType})失败: ${err.message}`);
        }
    }

    // ========== 远程光标选区渲染 ==========

    private applyRemoteCursor(msg: CursorMessage): void {
        const fileUri = this.resolveFilePath(msg.filePath);
        if (!fileUri) return;

        // 仅在当前用户也正好打开这个文件时渲染，否则忽略（因为不在眼前）
        const editor = vscode.window.activeTextEditor;
        if (!editor || this.getRelativePath(editor.document.uri) !== msg.filePath) {
            return;
        }

        const decorationType = this.getOrCreateDecorationType(msg.senderId);
        const rangesToDecorate = msg.selections.map(sel => {
            return new vscode.Range(
                new vscode.Position(sel.anchorLine, sel.anchorChar),
                new vscode.Position(sel.activeLine, sel.activeChar)
            );
        });

        editor.setDecorations(decorationType, rangesToDecorate);

        // 如果对方三秒没有移动光标，就淡出（或保持不清理，为避免残留，设定一个较长的失效时间，比如5分钟）
        if (this.cursorHideTimers.has(msg.senderId)) {
            clearTimeout(this.cursorHideTimers.get(msg.senderId)!);
        }
        this.cursorHideTimers.set(msg.senderId, setTimeout(() => {
            editor.setDecorations(decorationType, []);
        }, 120000)); // 2分钟无操作则隐藏光标
    }

    private getOrCreateDecorationType(senderId: string): vscode.TextEditorDecorationType {
        if (!this.decorationTypes.has(senderId)) {
            // 根据 ID 生成固定色相
            const hue = Math.abs(this.hashString(senderId)) % 360;
            const color = `hsl(${hue}, 90%, 45%)`;
            const bgColor = `hsla(${hue}, 90%, 45%, 0.25)`;

            const dec = vscode.window.createTextEditorDecorationType({
                backgroundColor: bgColor,
                border: `1px solid ${color}`,
                after: {
                    contentText: ` ${senderId.substring(0, 4)}`,
                    color: '#FFF',
                    backgroundColor: color,
                    fontWeight: 'bold',
                    margin: '0 0 0 2px'
                }
            });
            this.decorationTypes.set(senderId, dec);
        }
        return this.decorationTypes.get(senderId)!;
    }

    private hashString(str: string): number {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        return hash;
    }

    // ========== 全量工作区同步 ==========

    /** 已接收的文件计数 */
    private receivedSyncFiles: number = 0;

    /** 用于控制进度条显示 */
    private syncProgressResolve: ((value?: unknown) => void) | null = null;
    private syncProgressReject: ((reason?: any) => void) | null = null;
    private currentProgress: vscode.Progress<{ message?: string; increment?: number }> | null = null;

    /**
     * 应用全量工作区同步（Guest 加入时，支持分批接收）
     */
    private async applyWorkspaceSync(msg: WorkspaceSyncMessage): Promise<void> {
        const batchInfo = msg.totalBatches
            ? `(批次 ${(msg.batchIndex ?? 0) + 1}/${msg.totalBatches})`
            : '';
        console.log(`[Sync] 接收到工作区同步 ${batchInfo}，本批文件数: ${msg.files.length}`);

        // 全局锁定：同步期间一切本地事件不外发
        this.isWorkspaceSyncing = true;

        // 第一次接收时，启动一个带 Progress 的弹窗
        if ((msg.batchIndex === 0 || !this.currentProgress) && msg.totalBatches) {
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "正在同步工作区文件...",
                cancellable: false
            }, (progress) => {
                this.currentProgress = progress;
                return new Promise((resolve, reject) => {
                    this.syncProgressResolve = resolve;
                    this.syncProgressReject = reject;
                });
            });
        }

        if (this.currentProgress) {
            this.currentProgress.report({
                message: `处理第 ${(msg.batchIndex ?? 0) + 1}/${msg.totalBatches ?? 1} 批数据`,
                increment: msg.totalBatches ? (100 / msg.totalBatches) : 100
            });
        }

        try {
            for (const fileItem of msg.files) {
                const fileUri = this.resolveFilePath(fileItem.filePath);
                if (!fileUri) {
                    console.log(`[Sync] ❌ 警告: 无法解析路径 ${fileItem.filePath}`);
                    continue;
                }

                // 将此文件路径加入黑名单，持续 10 秒（极长安全余量）
                this.suppressPath(fileItem.filePath, 10000);

                // [修复核心Bug 1]：写入文件前，必须确保其父文件夹存在！否则 fs.writeFile 会直接死锁并抛出异常，导致后续同步全部丢弃。
                const dirUri = vscode.Uri.joinPath(fileUri, '..');
                try {
                    await vscode.workspace.fs.createDirectory(dirUri);
                } catch (e: any) {
                    console.error(`[Sync] ❌ 无法创建目录 ${dirUri.fsPath}: ${e.message}`);
                }

                // 写入文件内容
                const content = new TextEncoder().encode(fileItem.content);
                await vscode.workspace.fs.writeFile(fileUri, content);
                this.receivedSyncFiles++;

                // 极小延迟，避免长时间占用微任务队列导致 UI 死锁
                if (this.receivedSyncFiles % 5 === 0) {
                    await new Promise(r => setTimeout(r, 10));
                }
            }

            // 如果是单批次或最后一个批次
            const isLastBatch = !msg.totalBatches || (msg.batchIndex ?? 0) >= msg.totalBatches - 1;
            if (isLastBatch) {
                console.log(`[Sync] ✅ 全量同步完成，共 ${this.receivedSyncFiles} 个文件`);
                vscode.window.showInformationMessage(`✅ 已同步来自主机的 ${this.receivedSyncFiles} 个文件`);
                this.receivedSyncFiles = 0;

                // 结束进度条
                if (this.syncProgressResolve) {
                    this.syncProgressResolve();
                    this.syncProgressResolve = null;
                    this.syncProgressReject = null;
                    this.currentProgress = null;
                }

                // 【关键】延迟 5 秒解除全局锁，给 VS Code 充够的时间完成磁盘文件索引
                setTimeout(() => {
                    this.isWorkspaceSyncing = false;
                    console.log('[Sync] 🔓 全量同步锁已解除，开始正常编辑同步');
                }, 5000);
            }
        } catch (err: any) {
            console.error(`[Sync] 全量同步过程中出错: ${err.message}`);
            // 出错也要延迟释放锁
            setTimeout(() => { this.isWorkspaceSyncing = false; }, 3000);
            if (this.syncProgressReject) {
                this.syncProgressReject(err);
                this.syncProgressResolve = null;
                this.syncProgressReject = null;
                this.currentProgress = null;
            }
        }
    }

    /**
     * Host 端：扫描整个工作区文件夹并发送给 Guest（分批发送）
     */
    async sendWorkspaceSync(): Promise<void> {
        if (this.isWorkspaceSyncing) return;
        this.log('[Sync] 正在启动全量工作区同步...');
        this.isWorkspaceSyncing = true;

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "正在向协作者同步工作区文件...",
                cancellable: false
            }, async (progress) => {

                // 排除不需要同步的目录和文件
                // [Cross-IDE v3.0.0]：当前同步容量上限
                const excludePattern = '{**/node_modules/**,**/.git/**,**/out/**,**/.vscode/**,**/*.vsix,**/*.map,**/.DS_Store,**/.gemini/**}';
                const fileUris = await vscode.workspace.findFiles('**/*', excludePattern, 10000);

                this.log(`[Sync] 全局扫描完成，共命中 ${fileUris.length} 个待同步物理资产 (上限 10,000)`);

                progress.report({ message: "读取文件内容..." });

                // 读取所有文件内容
                const syncFiles: { filePath: string; content: string }[] = [];

                let processed = 0;
                const MAX_FILE_SIZE = 500 * 1024; // 500KB
                const MAX_BATCH_SIZE = 32 * 1024; // [修复Bug]：下调至 32KB，防止公共 MQTT Broker 直接丢弃过大的包，导致通信阻塞或被判定掉线
                for (const uri of fileUris) {
                    const relPath = this.getRelativePath(uri);
                    if (!relPath) continue;

                    try {
                        const stat = await vscode.workspace.fs.stat(uri);
                        if (stat.size > MAX_FILE_SIZE) {
                            console.log(`[Sync] 跳过超大文件 (>${MAX_FILE_SIZE / 1024}KB): ${relPath}`);
                            continue;
                        }

                        const rawBytes = await vscode.workspace.fs.readFile(uri);
                        const text = new TextDecoder('utf-8').decode(rawBytes);

                        // 跳过二进制文件
                        if (text.includes('\0')) {
                            continue;
                        }

                        syncFiles.push({ filePath: relPath, content: text });
                    } catch (err: any) {
                        console.log(`[Sync] 读取文件失败，跳过: ${relPath}`);
                    }

                    processed++;
                    if (processed % 10 === 0) {
                        progress.report({ message: `扫描进度: ${processed}/${fileUris.length}` });
                        await new Promise(r => setTimeout(r, 0));
                    }
                }

                console.log(`[Sync] 准备发送同步消息，包含 ${syncFiles.length} 个文件`);
                if (syncFiles.length === 0) return;

                // 分批
                const batches: { filePath: string; content: string }[][] = [];
                let currentBatch: { filePath: string; content: string }[] = [];
                let currentBatchSize = 0;

                for (const file of syncFiles) {
                    const itemSize = file.content.length + file.filePath.length + 50;

                    if (currentBatchSize + itemSize > MAX_BATCH_SIZE && currentBatch.length > 0) {
                        batches.push(currentBatch);
                        currentBatch = [];
                        currentBatchSize = 0;
                    }

                    currentBatch.push(file);
                    currentBatchSize += itemSize;
                }
                if (currentBatch.length > 0) {
                    batches.push(currentBatch);
                }

                const totalBatches = batches.length;

                for (let i = 0; i < totalBatches; i++) {
                    const batch = batches[i];
                    const msg: WorkspaceSyncMessage = {
                        type: MessageType.WORKSPACE_SYNC,
                        files: batch,
                        batchIndex: i,
                        totalBatches,
                    };

                    progress.report({
                        message: `发送数据批次 ${i + 1}/${totalBatches}`,
                        increment: 100 / totalBatches
                    });

                    console.log(`[Sync] 发送批次 ${i + 1}/${totalBatches}，文件数: ${batch.length}`);
                    this.sendMessage?.(msg);

                    // 批次之间加延迟
                    if (i < totalBatches - 1) {
                        await new Promise(r => setTimeout(r, 200));
                    }
                }
            });
        } finally {
            // Host 端发送完成后 3 秒解锁
            setTimeout(() => { this.isWorkspaceSyncing = false; }, 3000);
        }
    }

    /**
     * 强行下发当前主机的活跃编辑器窗口位置
     */
    public syncActiveFile(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') return;

        const filePath = this.getRelativePath(editor.document.uri);
        if (!filePath) return;

        console.log(`[Sync] 通知访客打开活跃文件: ${filePath}`);
        const msg: OpenFileMessage = {
            type: MessageType.OPEN_FILE,
            filePath
        };
        this.sendMessage?.(msg);
    }

    // ========== 增量编辑同步 ==========

    private async applyRemoteChange(msg: ChangeMessage): Promise<void> {
        // 过滤自己发出又被 broadcast 回来的消息
        if (msg.senderId === this.senderId) return;

        const fileUri = this.resolveFilePath(msg.filePath);
        if (!fileUri) return;

        // 将此路径加入黑名单，3 秒内不允许此路径的变更触发外发
        this.suppressPath(msg.filePath, 3000);

        // [输出日志节流]：避免每次打字都在 output 中刷屏
        const now = Date.now();
        const lastLogTime = this.changeLogTimers.get(msg.filePath) || 0;
        if (now - lastLogTime > 8000) { // 每 8 秒最多记录一次
            const uidStr = msg.senderId.substring(0, 4);
            this.log(`[Sync] ⌨️ 协作者 (ID: ${uidStr}) 正在修改文件: ${msg.filePath}`);
            this.changeLogTimers.set(msg.filePath, now);
        }

        try {
            const edit = new vscode.WorkspaceEdit();
            for (const change of msg.changes) {
                const range = new vscode.Range(
                    new vscode.Position(change.startLine, change.startChar),
                    new vscode.Position(change.endLine, change.endChar)
                );
                edit.replace(fileUri, range, change.text);
            }
            await vscode.workspace.applyEdit(edit);
        } catch (err: any) {
            console.error(`[Sync] 应用远端变更失败: ${err.message}`);
        }
    }

    private async applyFullSync(msg: FullSyncMessage): Promise<void> {
        const fileUri = this.resolveFilePath(msg.filePath);
        if (!fileUri) return;

        // 将此路径加入黑名单
        this.suppressPath(msg.filePath, 5000);

        try {
            let doc: vscode.TextDocument;
            try {
                doc = await vscode.workspace.openTextDocument(fileUri);
            } catch {
                const wsEdit = new vscode.WorkspaceEdit();
                wsEdit.createFile(fileUri, { ignoreIfExists: true });
                await vscode.workspace.applyEdit(wsEdit);
                doc = await vscode.workspace.openTextDocument(fileUri);
            }

            const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
            const edit = new vscode.WorkspaceEdit();
            edit.replace(fileUri, fullRange, msg.content);
            await vscode.workspace.applyEdit(edit);
        } catch (err: any) {
            console.error(`[Sync] 应用全量同步失败: ${err.message}`);
        }
    }

    private async handleSyncRequest(msg: RequestSyncMessage): Promise<void> {
        const fileUri = this.resolveFilePath(msg.filePath);
        if (!fileUri) return;
        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            const syncMsg: FullSyncMessage = {
                type: MessageType.FULL_SYNC,
                filePath: msg.filePath,
                content: doc.getText(),
            };
            this.sendMessage?.(syncMsg);
        } catch { }
    }

    // ========== 工具函数 ==========

    private getRelativePath(uri: vscode.Uri): string | null {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return null;
        const rootPath = workspaceFolders[0].uri.fsPath;
        const filePath = uri.fsPath;
        if (filePath.startsWith(rootPath)) {
            return filePath.substring(rootPath.length + 1).replace(/\\/g, '/');
        }
        return null;
    }

    private resolveFilePath(relativePath: string): vscode.Uri | null {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) return null;
        return vscode.Uri.joinPath(workspaceFolders[0].uri, relativePath);
    }

    dispose(): void {
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
        this.messageQueue = [];
        this.changeLogTimers.clear();
        this.suppressedPaths.clear();
        if (this.cursorSendTimer) clearTimeout(this.cursorSendTimer);
        for (const t of this.cursorHideTimers.values()) clearTimeout(t);
        this.cursorHideTimers.clear();
        for (const dec of this.decorationTypes.values()) {
            dec.dispose();
        }
        this.decorationTypes.clear();
    }
}
