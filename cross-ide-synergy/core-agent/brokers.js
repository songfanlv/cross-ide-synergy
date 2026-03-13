/**
 * 公共免费 MQTT Broker 列表 (从 TS 搬迁并转换为 JS)
 */
const mqtt = require('mqtt');

const MQTT_BROKERS = [
    { url: 'wss://broker.emqx.io:8084/mqtt', name: 'EMQX' },
    { url: 'wss://broker.hivemq.com:8884/mqtt', name: 'HiveMQ' },
    { url: 'wss://test.mosquitto.org:8081/mqtt', name: 'Mosquitto' },
];

function formatError(err) {
    if (!err) return '(未知错误)';
    const parts = [];
    if (err.message) parts.push(err.message);
    if (err.code) parts.push(`code=${err.code}`);
    if (err.errno) parts.push(`errno=${err.errno}`);
    return parts.length > 0 ? parts.join(', ') : String(err);
}

/**
 * 带回退的 MQTT 连接工厂 (JS 版)
 */
function connectWithFallback(options = {}) {
    const { logFn = console.log, timeoutMs = 6000 } = options;

    return new Promise((resolve, reject) => {
        let brokerIndex = 0;
        const errors = [];

        function tryNext() {
            if (brokerIndex >= MQTT_BROKERS.length) {
                reject(new Error(`所有 MQTT Broker 均无法连接。细节:\n${errors.join('\n')}`));
                return;
            }

            const broker = MQTT_BROKERS[brokerIndex];
            logFn(`[Agent-Broker] 正在尝试连接 ${broker.name}...`);

            const client = mqtt.connect(broker.url, {
                connectTimeout: timeoutMs,
                reconnectPeriod: 0, 
            });

            const timer = setTimeout(() => {
                const errMsg = `${broker.name}: 连接超时`;
                errors.push(errMsg);
                client.end(true);
                brokerIndex++;
                tryNext();
            }, timeoutMs);

            client.on('connect', () => {
                clearTimeout(timer);
                logFn(`[Agent-Broker] ✅ 成功连接到 ${broker.name}`);
                client.options.reconnectPeriod = 5000;
                resolve({ client, brokerName: broker.name, brokerUrl: broker.url });
            });

            client.on('error', (err) => {
                clearTimeout(timer);
                const errMsg = `${broker.name}: ${formatError(err)}`;
                logFn(`[Agent-Broker] ${broker.name} 连接失败，切换下一个...`);
                errors.push(errMsg);
                client.end(true);
                brokerIndex++;
                tryNext();
            });
        }

        tryNext();
    });
}

module.exports = {
    MQTT_BROKERS,
    formatError,
    connectWithFallback
};
