const INSTALLER_SHUTDOWN_ARGUMENT = '--quit-for-update';

function isInstallerShutdownRequest(argv) {
    return Array.isArray(argv) && argv.includes(INSTALLER_SHUTDOWN_ARGUMENT);
}

function shouldQuitOnWindowClose(isQuitting) {
    return isQuitting !== true;
}

module.exports = { INSTALLER_SHUTDOWN_ARGUMENT, isInstallerShutdownRequest, shouldQuitOnWindowClose };
