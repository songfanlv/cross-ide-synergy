const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

async function bundle() {
    console.log('[Bundle] Starting Core Agent bundling...');
    const rootDir = path.resolve(__dirname, '..');
    const entry = path.join(rootDir, 'core-agent', 'index.js');
    const outfile = path.join(rootDir, 'core-agent', 'bundle.js');

    try {
        await esbuild.build({
            entryPoints: [entry],
            bundle: true,
            minify: true,
            platform: 'node',
            outfile: outfile,
            external: ['vscode']
        });
        
        if (fs.existsSync(outfile)) {
            console.log(`[Bundle] ✅ Success! Bundle created at: ${outfile}`);
            console.log(`[Bundle] Size: ${fs.statSync(outfile).size} bytes`);
        } else {
            console.error('[Bundle] ❌ Failed! Outfile does not exist after build.');
            process.exit(1);
        }
    } catch (e) {
        console.error(`[Bundle] ❌ Error: ${e.message}`);
        process.exit(1);
    }
}

bundle();
