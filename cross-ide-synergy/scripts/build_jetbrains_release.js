const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

const ROOT = path.resolve(__dirname, '..');
const JB_DIR = path.join(ROOT, 'jetbrains-plugin');
const LOCAL_CACHE = path.join(JB_DIR, '.local-platform');
const GRADLE_VERSION = '9.3.1';
const IDEA_VERSION = '2024.1.7';
const IDEA_URL = `https://cache-redirector.jetbrains.com/www.jetbrains.com/intellij-repository/releases/com/jetbrains/intellij/idea/ideaIC/${IDEA_VERSION}/ideaIC-${IDEA_VERSION}.zip`;
const RELEASE_ZIP = path.join(ROOT, 'release', 'jetbrains', 'cross-ide-synergy-v3.0.0.zip');

async function main() {
    const gradleBin = await ensureGradle();
    const ideHome = detectLocalIde() || await ensureIdea();
    console.log(`[JetBrains] Using IDE home: ${ideHome}`);
    runGradleBuild(gradleBin, ideHome);
    packageRelease();
    console.log(`[JetBrains] Release packaged to ${RELEASE_ZIP}`);
}

async function ensureGradle() {
    const cacheRoot = path.join(LOCAL_CACHE, 'gradle');
    const zipPath = path.join(cacheRoot, `gradle-${GRADLE_VERSION}-bin.zip`);
    const extractRoot = path.join(cacheRoot, `gradle-${GRADLE_VERSION}`);
    const gradleBin = path.join(extractRoot, 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle');

    if (!fs.existsSync(gradleBin)) {
        fs.mkdirSync(cacheRoot, { recursive: true });
        await downloadFile(`https://downloads.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip`, zipPath, 'Gradle');
        extractZip(zipPath, cacheRoot);
    }

    return gradleBin;
}

async function ensureIdea() {
    const cacheRoot = path.join(LOCAL_CACHE, 'idea');
    const zipPath = path.join(cacheRoot, `ideaIC-${IDEA_VERSION}.zip`);
    const extractRoot = path.join(cacheRoot, `ideaIC-${IDEA_VERSION}`);

    if (!fs.existsSync(extractRoot)) {
        fs.mkdirSync(cacheRoot, { recursive: true });
        await downloadFile(IDEA_URL, zipPath, 'IntelliJ Platform');
        fs.mkdirSync(extractRoot, { recursive: true });
        extractZip(zipPath, extractRoot);
    }

    const entries = fs.readdirSync(extractRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    if (entries.length === 1) {
        return path.join(extractRoot, entries[0].name);
    }
    return extractRoot;
}

function detectLocalIde() {
    const explicit = process.env.CROSSIDE_LOCAL_IDE_PATH;
    if (explicit && isValidIdeHome(explicit)) {
        return explicit;
    }

    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
        return null;
    }

    const jetBrainsDir = path.join(localAppData, 'JetBrains');
    if (!fs.existsSync(jetBrainsDir)) {
        return null;
    }

    const configDirs = fs.readdirSync(jetBrainsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(jetBrainsDir, entry.name));

    for (const configDir of configDirs) {
        const homeMarker = path.join(configDir, '.home');
        if (!fs.existsSync(homeMarker)) {
            continue;
        }

        const markerText = fs.readFileSync(homeMarker, 'utf8').trim();
        if (isValidIdeHome(markerText)) {
            return markerText;
        }

        const driveMatch = markerText.match(/^[A-Za-z]:\\/);
        if (driveMatch) {
            const scanned = scanDriveForIde(driveMatch[0]);
            if (scanned) {
                return scanned;
            }
        }
    }

    return null;
}

async function downloadFile(url, outFile, label) {
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
        console.log(`[JetBrains] Reusing cached ${label}: ${outFile}`);
        return;
    }

    console.log(`[JetBrains] Downloading ${label}...`);
    const tempFile = `${outFile}.tmp`;
    if (fs.existsSync(tempFile) && fs.statSync(tempFile).size === 0) {
        fs.rmSync(tempFile, { force: true });
    }
    if (tryCurlDownload(url, tempFile, label)) {
        fs.renameSync(tempFile, outFile);
        return;
    }
    await downloadToFile(url, tempFile, label, 0);
    fs.renameSync(tempFile, outFile);
}

function tryCurlDownload(url, outFile, label) {
    const whereCurl = spawnSync(process.platform === 'win32' ? 'where' : 'which', [process.platform === 'win32' ? 'curl.exe' : 'curl'], {
        stdio: 'ignore',
        windowsHide: true,
    });
    if (whereCurl.status !== 0) {
        return false;
    }

    console.log(`[JetBrains] Using curl for ${label} download with retry/resume`);
    const result = spawnSync(process.platform === 'win32' ? 'curl.exe' : 'curl', [
        '--fail',
        '--location',
        '--retry',
        '10',
        '--retry-delay',
        '5',
        '--retry-all-errors',
        '--continue-at',
        '-',
        '--output',
        outFile,
        url,
    ], {
        stdio: 'inherit',
        windowsHide: true,
    });
    return result.status === 0;
}

function downloadToFile(url, outFile, label, redirectCount) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 10) {
            reject(new Error(`${label} download hit too many redirects`));
            return;
        }

        const request = https.get(url, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                const nextUrl = new URL(response.headers.location, url).toString();
                resolve(downloadToFile(nextUrl, outFile, label, redirectCount + 1));
                return;
            }

            if (response.statusCode !== 200) {
                reject(new Error(`${label} download failed with HTTP ${response.statusCode}`));
                return;
            }

            const totalBytes = Number(response.headers['content-length'] || 0);
            let receivedBytes = 0;
            let lastProgressAt = Date.now();
            const progressTimer = setInterval(() => {
                const idleMs = Date.now() - lastProgressAt;
                const progress = totalBytes > 0 ? ` ${(receivedBytes / totalBytes * 100).toFixed(1)}%` : '';
                console.log(`[JetBrains] Downloading ${label}:${progress}`);
                if (idleMs > 5 * 60 * 1000) {
                    clearInterval(progressTimer);
                    response.destroy(new Error(`${label} download stalled`));
                }
            }, 30 * 1000);

            const file = fs.createWriteStream(outFile);
            response.on('data', (chunk) => {
                receivedBytes += chunk.length;
                lastProgressAt = Date.now();
            });
            response.pipe(file);
            file.on('finish', () => {
                clearInterval(progressTimer);
                file.close(resolve);
            });
            file.on('error', (error) => {
                clearInterval(progressTimer);
                reject(error);
            });
            response.on('error', (error) => {
                clearInterval(progressTimer);
                reject(error);
            });
        });
        request.on('error', reject);
    });
}

function extractZip(zipPath, destination) {
    console.log(`[JetBrains] Extracting ${path.basename(zipPath)}...`);
    const tarResult = spawnSync('tar', ['-xf', zipPath, '-C', destination], {
        stdio: 'inherit',
        windowsHide: true,
    });
    if (tarResult.status === 0) {
        return;
    }

    new AdmZip(zipPath).extractAllTo(destination, true);
}

function runGradleBuild(gradleBin, ideHome) {
    const watchdog = path.join(ROOT, 'scripts', 'run_with_idle_timeout.js');
    const logFile = path.join(JB_DIR, 'build_watchdog.log');
    const javaHome = resolveBuildJavaHome(ideHome);
    const env = {
        ...process.env,
        ORG_GRADLE_PROJECT_localIdePath: ideHome,
    };

    if (javaHome) {
        const javaBin = path.join(javaHome, 'bin');
        env.JAVA_HOME = javaHome;
        env.JDK_HOME = javaHome;
        env.PATH = `${javaBin}${path.delimiter}${env.PATH || ''}`;
        console.log(`[JetBrains] Using build JDK: ${javaHome}`);
    }

    const result = spawnSync(process.execPath, [
        watchdog,
        '--cwd',
        JB_DIR,
        '--idle-ms',
        '300000',
        '--max-ms',
        '1800000',
        '--heartbeat-ms',
        '30000',
        '--log-file',
        logFile,
        '--',
        gradleBin,
        'buildPlugin',
        '--no-daemon',
        '--stacktrace',
        '--console=plain',
        '--info',
    ], {
        cwd: ROOT,
        env,
        stdio: 'inherit',
        windowsHide: true,
    });

    if (result.status !== 0) {
        throw new Error(`JetBrains Gradle build failed with exit code ${result.status}`);
    }
}

function resolveBuildJavaHome(ideHome) {
    const candidates = [
        path.join(ideHome, 'jbr'),
        path.join(ideHome, 'jre64'),
        process.env.JAVA_HOME,
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))) {
            return candidate;
        }
    }

    return null;
}

function packageRelease() {
    const distDir = path.join(JB_DIR, 'build', 'distributions');
    const pluginZipName = fs.readdirSync(distDir).find((name) => name.endsWith('.zip'));
    if (!pluginZipName) {
        throw new Error(`No plugin ZIP found in ${distDir}`);
    }

    const pluginZip = new AdmZip(path.join(distDir, pluginZipName));
    const entries = pluginZip.getEntries();
    const rootName = entries.find((entry) => entry.entryName.includes('/'))?.entryName.split('/')[0];
    if (!rootName) {
        throw new Error('Unable to detect plugin ZIP root directory');
    }

    pluginZip.addLocalFile(path.join(ROOT, 'core-agent', 'bundle.js'), `${rootName}/lib/core-agent`);
    pluginZip.addLocalFile(path.join(ROOT, 'core-agent', 'package.json'), `${rootName}/lib/core-agent`);

    fs.mkdirSync(path.dirname(RELEASE_ZIP), { recursive: true });
    pluginZip.writeZip(RELEASE_ZIP);
}

function isValidIdeHome(candidate) {
    if (!candidate) {
        return false;
    }
    return fs.existsSync(path.join(candidate, 'lib')) && fs.existsSync(path.join(candidate, 'product-info.json'));
}

function scanDriveForIde(driveRoot) {
    const jetBrainsName = /(PyCharm|IntelliJ|WebStorm|GoLand|CLion|Rider|PhpStorm|DataGrip)/i;
    const topLevel = safeReadDirs(driveRoot);

    for (const entry of topLevel) {
        if (jetBrainsName.test(entry.name) && isValidIdeHome(entry.fullPath)) {
            return entry.fullPath;
        }

        const children = safeReadDirs(entry.fullPath);
        for (const child of children) {
            if (jetBrainsName.test(child.name) && isValidIdeHome(child.fullPath)) {
                return child.fullPath;
            }
        }
    }

    return null;
}

function safeReadDirs(dirPath) {
    try {
        return fs.readdirSync(dirPath, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => ({ name: entry.name, fullPath: path.join(dirPath, entry.name) }));
    } catch {
        return [];
    }
}

main().catch((error) => {
    console.error(`\n[JetBrains][FAIL] ${error.stack || error.message}`);
    process.exitCode = 1;
});
