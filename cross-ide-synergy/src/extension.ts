import * as vscode from 'vscode';

export async function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Cross-IDE Synergy');
    outputChannel.show(true);
    outputChannel.appendLine('[Cross-IDE Synergy] Safe bootstrap wrapper activated. Loading core module...');

    try {
        const extMain = require('./extension_main');
        await extMain.activateMain(context, outputChannel);
        outputChannel.appendLine('[Cross-IDE Synergy] Core module loaded.');
    } catch (err: any) {
        outputChannel.appendLine(`\n[CRITICAL ERROR] Failed to load core module: ${err.message}`);
        outputChannel.appendLine(`Stack trace:\n${err.stack}`);

        vscode.window.showErrorMessage('Cross-IDE Synergy failed to start. Check the Output panel for details.');
        console.error('[Cross-IDE Synergy] Core failure:', err);
    }
}

export function deactivate() {
    try {
        const extMain = require('./extension_main');
        if (typeof extMain.deactivate === 'function') {
            extMain.deactivate();
        }
    } catch {
        // Ignored
    }
}
