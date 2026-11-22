const fs = require('node:fs');
const path = require('node:path');

// Where the installed app keeps everything it writes: a "data" folder inside its own
// installation folder (settings, .env, logs, caches, temporary files, the tunnel's work
// folder), so nothing is spread over the rest of the system and uninstalling removes
// it all. Falls back to Electron's default folder when the installation folder cannot
// be written to (for example an installation by an administrator for all users).
function chooseDataRoot({ isPackaged, execPath, canWrite = isWritable }) {
    if (!isPackaged) return null;
    const root = path.join(path.dirname(execPath), 'data');
    return canWrite(root) ? root : null;
}

function isWritable(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, `.write-test-${process.pid}`);
        fs.writeFileSync(probe, '');
        fs.unlinkSync(probe);
        return true;
    } catch (error) {
        return false;
    }
}

function dataPaths(root) {
    return {
        userData: root,
        sessionData: path.join(root, 'session'),
        temp: path.join(root, 'tmp'),
        logs: path.join(root, 'logs'),
        crashDumps: path.join(root, 'crashes'),
        work: path.join(root, 'work')
    };
}

// Copies the user's settings from the folder older versions used, once.
function migrateFrom(oldDir, newDir, files = ['settings.json', '.env']) {
    const copied = [];
    for (const name of files) {
        const from = path.join(oldDir, name);
        const to = path.join(newDir, name);
        try {
            if (fs.existsSync(from) && !fs.existsSync(to)) {
                fs.mkdirSync(newDir, { recursive: true });
                fs.copyFileSync(from, to);
                copied.push(name);
            }
        } catch (error) { /* keep going */ }
    }
    return copied;
}

module.exports = { chooseDataRoot, dataPaths, migrateFrom, isWritable };
