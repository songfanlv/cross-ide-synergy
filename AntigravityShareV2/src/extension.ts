import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Antigravity Share');
    outputChannel.show(true);
    outputChannel.appendLine('[Antigravity Share] 安全包裹层已激活，正在尝试加载核心模块...');

    try {
        // 延迟加载真正的业务代码，防止由于外部依赖（如 ws）导致的顶级崩溃
        const extMain = require('./extension_main');
        extMain.activateMain(context, outputChannel);
        outputChannel.appendLine('[Antigravity Share] 核心模块加载完成！');
    } catch (err: any) {
        outputChannel.appendLine(`\n[CRITICAL ERROR] 无法加载核心模块: ${err.message}`);
        outputChannel.appendLine(`堆栈追踪:\n${err.stack}`);

        vscode.window.showErrorMessage(`反重力协作插件底层崩溃，请查看输出面板 (Output) 获取原因。`);
        console.error('[Antigravity Share] 底层崩溃:', err);
    }
}

export function deactivate() {
    try {
        const extMain = require('./extension_main');
        if (typeof extMain.deactivate === 'function') {
            extMain.deactivate();
        }
    } catch (err) {
        // Ignored
    }
}
