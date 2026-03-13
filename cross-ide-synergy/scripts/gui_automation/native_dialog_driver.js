const path = require('path');
const { waitUntil } = require('./common');

class NativeDialogDriver {
    constructor(options) {
        this.client = options.client;
        this.artifactDir = options.artifactDir;
        this.log = options.log || (() => {});
    }

    async acceptPyCharmTrustDialog(projectName) {
        const session = await this.client.createDesktopSession();
        try {
            const candidates = [
                `//*[contains(@Name, '${escapeXPathLiteral(projectName)}')]//*[@Name='Trust Project']`,
                `//*[contains(@Name, '${escapeXPathLiteral(projectName)}')]//*[@Name='Trust and Open']`,
                "//*[@Name='Trust Project']",
                "//*[@Name='Trust and Open']",
            ];

            const buttonId = await waitUntil('PyCharm 信任对话框', 30000, async () => {
                for (const xpath of candidates) {
                    try {
                        return await session.findElement('xpath', xpath);
                    } catch {
                        // Try the next selector.
                    }
                }
                return null;
            }, 1000);

            await session.screenshot(path.join(this.artifactDir, 'pycharm-trust-dialog.png')).catch(() => {});
            this.log(`接受 PyCharm 信任对话框: ${projectName}`);
            await session.click(buttonId);
            return true;
        } catch {
            return false;
        } finally {
            await session.delete().catch(() => {});
        }
    }

    async clickSystemButton(buttonNames, screenshotName) {
        const session = await this.client.createDesktopSession();
        try {
            const elementId = await waitUntil(`系统按钮 ${buttonNames.join('/')}`, 15000, async () => {
                for (const buttonName of buttonNames) {
                    try {
                        return await session.findElement('name', buttonName);
                    } catch {
                        // Continue searching.
                    }
                }
                return null;
            }, 500);
            if (screenshotName) {
                await session.screenshot(path.join(this.artifactDir, screenshotName)).catch(() => {});
            }
            await session.click(elementId);
            return true;
        } finally {
            await session.delete().catch(() => {});
        }
    }
}

function escapeXPathLiteral(value) {
    return String(value).replace(/'/g, '');
}

module.exports = {
    NativeDialogDriver,
};
