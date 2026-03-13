const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3000');

ws.on('open', () => {
    console.log('[Test] 已连接至 Sidecar Agent');

    // 1. 获取状态
    ws.send(JSON.stringify({
        jsonrpc: "2.0",
        method: "get_status",
        id: 1
    }));

    // 2. 启动 Host 分享
    setTimeout(() => {
        console.log('\n[Test] 发起 start_host 指令...');
        ws.send(JSON.stringify({
            jsonrpc: "2.0",
            method: "start_host",
            params: { shareCode: "PAPA66" },
            id: 2
        }));
    }, 1000);

    // 3. 再次检查状态
    setTimeout(() => {
        ws.send(JSON.stringify({
            jsonrpc: "2.0",
            method: "get_status",
            id: 3
        }));
    }, 3000);
});

ws.on('message', (data) => {
    console.log('[收到响应]', JSON.parse(data.toString()));
});

ws.on('close', () => {
    console.log('[Test] 连接已关闭');
});

ws.on('error', (err) => {
    console.error('[错误]', err.message);
});

// 保持进程运行一会儿以接收心跳或最后的响应
setTimeout(() => {
    console.log('[Test] 测试结束，退出。');
    process.exit(0);
}, 6000);
