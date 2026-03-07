/**
 * MQTT Broker 多节点管理 - 自动切换备用 Broker
 */

import * as mqtt from 'mqtt';

/** 公共免费 MQTT Broker 列表（按优先级排列） */
export const MQTT_BROKERS = [
    { url: 'wss://broker.emqx.io:8084/mqtt', name: 'EMQX' },
    { url: 'wss://broker.hivemq.com:8884/mqtt', name: 'HiveMQ' },
    { url: 'wss://test.mosquitto.org:8081/mqtt', name: 'Mosquitto' },
];

/** 内置公共 WebSocket 中继 URL（备用方案，无需用户手动配置） */
export const DEFAULT_RELAY_URL = '';  // 暂时留空，后续部署后填入

/**
 * 格式化错误对象，输出尽可能完整的错误信息
 */
export function formatError(err: any): string {
    if (!err) return '(未知错误)';
    const parts: string[] = [];
    if (err.message) parts.push(err.message);
    if (err.code) parts.push(`code=${err.code}`);
    if (err.errno) parts.push(`errno=${err.errno}`);
    if (err.syscall) parts.push(`syscall=${err.syscall}`);
    if (err.address) parts.push(`address=${err.address}`);
    if (err.port) parts.push(`port=${err.port}`);
    return parts.length > 0 ? parts.join(', ') : String(err);
}

/**
 * 带回退的 MQTT 连接工厂（Host 使用）
 * 依次尝试多个 Broker，直到连接成功
 * 返回 { client, brokerName } 以便知道连上了哪个
 */
export function connectWithFallback(
    logFn: (msg: string) => void,
    timeoutMs: number = 6000
): Promise<{ client: mqtt.MqttClient; brokerName: string; brokerUrl: string }> {
    return new Promise((resolve, reject) => {
        let brokerIndex = 0;
        const errors: string[] = [];

        function tryNext() {
            if (brokerIndex >= MQTT_BROKERS.length) {
                const detail = errors.length > 0
                    ? `\n详细错误:\n${errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')}`
                    : '';
                reject(new Error(`所有 MQTT Broker 均无法连接，请检查网络${detail}`));
                return;
            }

            const broker = MQTT_BROKERS[brokerIndex];
            logFn(`[Broker] 正在尝试连接 ${broker.name} (${broker.url})...`);

            const client = mqtt.connect(broker.url, {
                connectTimeout: timeoutMs,
                reconnectPeriod: 0, // 不自动重连，由我们手动管理
            });

            const timer = setTimeout(() => {
                const errMsg = `${broker.name}: 连接超时 (${timeoutMs}ms)`;
                logFn(`[Broker] ${errMsg}，切换下一个...`);
                errors.push(errMsg);
                client.end(true);
                brokerIndex++;
                tryNext();
            }, timeoutMs);

            client.on('connect', () => {
                clearTimeout(timer);
                logFn(`[Broker] ✅ 成功连接到 ${broker.name}`);
                // 重新启用自动重连
                (client as any).options.reconnectPeriod = 5000;
                resolve({ client, brokerName: broker.name, brokerUrl: broker.url });
            });

            client.on('error', (err: any) => {
                clearTimeout(timer);
                const errMsg = `${broker.name}: ${formatError(err)}`;
                logFn(`[Broker] ${broker.name} 连接失败: ${formatError(err)}，切换下一个...`);
                errors.push(errMsg);
                client.end(true);
                brokerIndex++;
                tryNext();
            });
        }

        tryNext();
    });
}

/**
 * 连接到指定的 Broker（Guest 使用，可以指定优先尝试某个 broker）
 */
export function connectToBroker(
    logFn: (msg: string) => void,
    brokerUrl: string,
    brokerName: string,
    timeoutMs: number = 6000
): Promise<mqtt.MqttClient> {
    return new Promise((resolve, reject) => {
        logFn(`[Broker] 正在连接 ${brokerName} (${brokerUrl})...`);

        const client = mqtt.connect(brokerUrl, {
            connectTimeout: timeoutMs,
            reconnectPeriod: 0,
        });

        const timer = setTimeout(() => {
            logFn(`[Broker] ${brokerName} 连接超时 (${timeoutMs}ms)`);
            client.end(true);
            reject(new Error(`${brokerName} 连接超时`));
        }, timeoutMs);

        client.on('connect', () => {
            clearTimeout(timer);
            logFn(`[Broker] ✅ 成功连接到 ${brokerName}`);
            (client as any).options.reconnectPeriod = 5000;
            resolve(client);
        });

        client.on('error', (err: any) => {
            clearTimeout(timer);
            const detail = formatError(err);
            logFn(`[Broker] ${brokerName} 连接失败: ${detail}`);
            client.end(true);
            reject(new Error(`${brokerName}: ${detail}`));
        });
    });
}
