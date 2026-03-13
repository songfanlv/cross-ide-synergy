import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | null = null;

export function initLogger(channel: vscode.OutputChannel) {
    outputChannel = channel;
}

export function logInfo(msg: string) {
    console.log(msg);
    if (outputChannel) {
        // 自动加上时间戳，方便排障
        const time = new Date().toLocaleTimeString();
        outputChannel.appendLine(`[${time}] [INFO] ${msg}`);
    }
}

export function logError(msg: string, err?: any) {
    console.error(msg, err);
    if (outputChannel) {
        const time = new Date().toLocaleTimeString();
        outputChannel.appendLine(`[${time}] [ERROR] ${msg}` + (err ? ` - ${err.message || JSON.stringify(err)}` : ''));
    }
}
