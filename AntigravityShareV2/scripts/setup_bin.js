const path = require('path');
const fs = require('fs');

async function setup() {
    const targetDir = path.join(__dirname, '..', 'out', 'bin');
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const binName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const targetPath = path.join(targetDir, binName);

    if (fs.existsSync(targetPath)) {
        console.log(`✅ ${binName} 已存在，跳过下载。`);
        return;
    }

    console.log(`正在准备下载 cloudflared 二进制文件到: ${targetPath}`);
    try {
        await install(targetPath);
        console.log('✅ 下载成功！');
    } catch (err) {
        console.error('❌ 下载失败:', err.message);
        process.exit(1);
    }
}

setup();
