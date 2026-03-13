const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const targets = [
    'out',
    'tmp',
    path.join('core-agent', 'bundle.js'),
    path.join('core-agent', 'agent-runtime.log'),
];

for (const relativePath of targets) {
    removeWithRetry(path.join(rootDir, relativePath));
}

function removeWithRetry(targetPath) {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            fs.rmSync(targetPath, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 100,
            });
            return;
        } catch (error) {
            if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error.code) || attempt === 4) {
                throw error;
            }
        }
    }
}
