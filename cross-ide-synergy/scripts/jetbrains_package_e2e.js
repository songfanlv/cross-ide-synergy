const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

const ROOT = path.resolve(__dirname, '..');
const ZIP_PATH = path.join(ROOT, 'release', 'jetbrains', 'cross-ide-synergy-v3.0.0.zip');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-jb-'));
const EXTRACT_DIR = path.join(TMP_DIR, 'plugin');
let PACKAGE_ROOT = '';
let JAR_PATH = '';
let BUNDLE_PATH = '';

function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

function inspectPackage() {
    assert(fs.existsSync(ZIP_PATH), `JetBrains package not found: ${ZIP_PATH}`);

    const outerZip = new AdmZip(ZIP_PATH);
    outerZip.extractAllTo(EXTRACT_DIR, true);

    const rootEntries = fs.readdirSync(EXTRACT_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    assert(rootEntries.length >= 1, `No plugin root directory found in ${EXTRACT_DIR}`);

    PACKAGE_ROOT = path.join(EXTRACT_DIR, rootEntries[0].name);
    const libDir = path.join(PACKAGE_ROOT, 'lib');
    BUNDLE_PATH = path.join(libDir, 'core-agent', 'bundle.js');

    assert(fs.existsSync(BUNDLE_PATH), `Missing bundled core-agent in package: ${BUNDLE_PATH}`);
    const jarCandidates = fs.readdirSync(libDir)
        .filter((entry) => entry.endsWith('.jar'))
        .map((entry) => path.join(libDir, entry));
    assert(jarCandidates.length > 0, `Missing plugin JAR in ${libDir}`);

    let pluginXmlEntry = null;
    let entries = [];
    for (const jarPath of jarCandidates) {
        const jarZip = new AdmZip(jarPath);
        const candidatePluginXml = jarZip.getEntry('META-INF/plugin.xml');
        if (!candidatePluginXml) {
            continue;
        }

        JAR_PATH = jarPath;
        pluginXmlEntry = candidatePluginXml;
        entries = jarZip.getEntries().map((entry) => entry.entryName);
        break;
    }

    assert(JAR_PATH, `plugin.xml missing in all JARs under ${libDir}`);

    const pluginXml = pluginXmlEntry.getData().toString('utf8');
    const classEntries = entries.filter((entry) => entry.endsWith('.class'));

    console.log(`[JetBrains] ZIP extracted to ${EXTRACT_DIR}`);
    console.log(`[JetBrains] JAR entries: ${entries.length}`);
    console.log(`[JetBrains] Class entries: ${classEntries.length}`);

    if (classEntries.length === 0) {
        console.log('[JetBrains][WARN] JAR contains no .class files; this package is metadata-only.');
    }

    const actionClassMatch = pluginXml.match(/class="([^"]+)"/);
    if (actionClassMatch) {
        console.log(`[JetBrains] action class: ${actionClassMatch[1]}`);
    }

    return { pluginXml, classEntries };
}

async function runE2E() {
    const [hostPort, guestPort] = await Promise.all([findFreePort(), findFreePort()]);

    await new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [path.join(ROOT, 'scripts', 'real_dual_e2e.js')], {
            cwd: ROOT,
            env: {
                ...process.env,
                CROSSIDE_AGENT_ENTRY: BUNDLE_PATH,
                CROSSIDE_HOST_PORT: String(hostPort),
                CROSSIDE_GUEST_PORT: String(guestPort),
                CROSSIDE_ROUNDS: '5',
            },
            stdio: 'inherit',
        });

        proc.once('exit', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`JetBrains package E2E exited with code ${code}`));
            }
        });

        proc.once('error', reject);
    });
}

function findFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => reject(new Error('failed to allocate free port')));
                return;
            }

            const { port } = address;
            server.close((err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(port);
            });
        });
    });
}

async function main() {
    try {
        const { pluginXml, classEntries } = inspectPackage();
        await runE2E();

        if (classEntries.length === 0) {
            console.log('\n[JetBrains][RESULT] Package sidecar bundle passed 5 rounds, but the JetBrains JAR has no implementation classes.');
            console.log('[JetBrains][RESULT] This means the install package is not a real functional IDE plugin yet.');
        } else {
            console.log('\n[JetBrains][RESULT] Package structure and sidecar bundle passed.');
        }
    } finally {
        fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error(`\n[JetBrains][FAIL] ${err.stack || err.message}`);
    process.exitCode = 1;
});
