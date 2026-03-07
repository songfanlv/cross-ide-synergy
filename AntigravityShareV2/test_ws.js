/**
 * 纯 Node.js WebSocket 连通性测试
 * 在同一台机器上启动服务器和客户端，验证底层网络是否正常
 */
const ws = require('ws');

const PORT = 19876;

// 启动服务器
const server = new ws.WebSocketServer({ host: '0.0.0.0', port: PORT });

server.on('listening', () => {
    console.log(`[服务器] 已启动，监听端口: ${PORT}`);

    // 启动客户端
    console.log('[客户端] 正在连接到 ws://127.0.0.1:' + PORT);
    const client = new ws.WebSocket(`ws://127.0.0.1:${PORT}`);

    client.on('open', () => {
        console.log('[客户端] 连接成功！');
        client.send('你好，服务器！');
    });

    client.on('message', (data) => {
        console.log(`[客户端] 收到消息: ${data}`);
        client.close();
    });

    client.on('error', (err) => {
        console.error(`[客户端] 连接错误:`, err.message);
    });

    client.on('close', () => {
        console.log('[客户端] 已断开');
        server.close(() => {
            console.log('[服务器] 已停止');
            console.log('\n=== 测试通过！网络环境正常 ===');
        });
    });
});

server.on('connection', (socket) => {
    console.log('[服务器] 客户端已连接');
    socket.on('message', (data) => {
        console.log(`[服务器] 收到消息: ${data}`);
        socket.send('你好，客户端！');
    });
});

server.on('error', (err) => {
    console.error(`[服务器] 启动失败:`, err.message);
    process.exit(1);
});

// 10 秒超时
setTimeout(() => {
    console.error('\n=== 测试失败：10秒超时 ===');
    process.exit(1);
}, 10000);
