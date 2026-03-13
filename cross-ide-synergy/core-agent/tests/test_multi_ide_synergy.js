const WebSocket = require('ws');

/**
 * 跨 IDE 本地同步 (共振) 测试脚本
 * 模拟场景：本地同时启动了 VSCode 和 IntelliJ，它们都接到了同一个 Sidecar Agent
 */

const AGENT_URL = 'ws://localhost:3000';

const clientA = new WebSocket(AGENT_URL); // 模拟 VSCode
const clientB = new WebSocket(AGENT_URL); // 模拟 IntelliJ

let receivedByA = false;
let receivedByB = false;

clientA.on('open', () => {
    console.log('[IDE A] VSCode 已接入核心 Agent');
    // A 启动 Host 模式
    clientA.send(JSON.stringify({
        jsonrpc: "2.0",
        method: "start_host",
        params: { shareCode: "SYNC100" },
        id: "a1"
    }));
});

clientB.on('open', () => {
    console.log('[IDE B] IntelliJ 已接入核心 Agent');
});

// A 监听消息
clientA.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.text === 'Hello from IntelliJ') {
        console.log('[IDE A] ✅ 成功接收到来自 IntelliJ 的本地共振消息！');
        receivedByA = true;
    }
});

// B 监听消息
clientB.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.text === 'Hello from VSCode') {
        console.log('[IDE B] ✅ 成功接收到来自 VSCode 的本地共振消息！');
        receivedByB = true;
    }
});

// 执行测试序列
setTimeout(() => {
    console.log('\n[Trigger] VSCode 发起变更...');
    clientA.send(JSON.stringify({
        type: "change",
        filePath: "test.js",
        text: "Hello from VSCode"
    }));
}, 2000);

setTimeout(() => {
    console.log('\n[Trigger] IntelliJ 发起变更...');
    clientB.send(JSON.stringify({
        type: "change",
        filePath: "test.js",
        text: "Hello from IntelliJ"
    }));
}, 4000);

setTimeout(() => {
    if (receivedByA && receivedByB) {
        console.log('\n[RESULT] 🎉 跨 IDE 本地共振测试圆满成功！');
        console.log('证明了 Sidecar Agent 可以完美桥接本地多个异构 IDE 的状态。');
        process.exit(0);
    } else {
        console.error('\n[RESULT] ❌ 测试失败，消息未能送达。');
        process.exit(1);
    }
}, 6000);
