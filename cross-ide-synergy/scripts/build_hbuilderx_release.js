const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE_PATH = path.join(ROOT, 'core-agent', 'bundle.js');
const RELEASE_DIR = path.join(ROOT, 'release', 'hbuilderx');
const OUTPUT_ZIP = path.join(RELEASE_DIR, 'cross-ide-synergy-hbuilderx-v3.0.0.zip');
const STAGING_DIR = path.join(ROOT, 'tmp', 'hbuilderx-release');
const PLUGIN_DIR = path.join(STAGING_DIR, 'cross-ide-synergy');

function main() {
    ensureBundle();
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    fs.mkdirSync(PLUGIN_DIR, { recursive: true });
    fs.mkdirSync(RELEASE_DIR, { recursive: true });

    const pluginPackage = {
        name: 'cross-ide-synergy',
        version: '3.0.0',
        description: 'Cross-IDE collaboration plugin for HBuilderX',
        main: 'bundle.js',
        engines: {
            hbuilderx: '^3.0.0',
        },
    };

    fs.writeFileSync(
        path.join(PLUGIN_DIR, 'package.json'),
        `${JSON.stringify(pluginPackage, null, 2)}\n`,
        'utf8'
    );
    fs.copyFileSync(BUNDLE_PATH, path.join(PLUGIN_DIR, 'bundle.js'));

    const zip = new AdmZip();
    zip.addLocalFolder(PLUGIN_DIR, 'cross-ide-synergy');
    zip.writeZip(OUTPUT_ZIP);

    console.log(`[HBuilderX] Release packaged to ${OUTPUT_ZIP}`);
}

function ensureBundle() {
    if (!fs.existsSync(BUNDLE_PATH)) {
        throw new Error('Missing core-agent/bundle.js. Run npm run bundle:agent or npm run build:release first.');
    }
}

main();
