// The device's back end, isolated in its own process: the session server, the device's
// own TURN relay, UPnP port mapping, the public tunnel and local-network discovery.
// The desktop app starts it with Electron's utilityProcess (a separate process with only
// a message channel to the windows' process) and restarts it if it stops; tests start
// it as a plain Node child process. It keeps nothing outside the folders it is given.
const { createLocalHostNode } = require('./server');
const { createPortMapper } = require('./upnp');
const { createTunnel } = require('./tunnel');
const { findHostByCodeOnLan } = require('./discovery');

const channel = process.parentPort
    ? { send: (message) => process.parentPort.postMessage(message), on: (fn) => process.parentPort.on('message', (event) => fn(event.data)) }
    : { send: (message) => process.send && process.send(message), on: (fn) => process.on('message', fn) };

let node = null;
let mapper = null;
let tunnel = null;

async function start(config) {
    mapper = createPortMapper();
    node = createLocalHostNode({
        hostSecret: config.secret,
        port: config.port || 0,
        extraIceServers: Array.isArray(config.extraIceServers) ? config.extraIceServers : [],
        resolvePublicEndpoint: (port, protocol) => mapper.map(port, protocol),
        resolveWebUrl: async (localPort) => {
            if (config.tunnelOff) return null;
            if (!tunnel) {
                tunnel = createTunnel({
                    binary: config.cloudflared,
                    localPort,
                    token: config.tunnelToken || '',
                    publicUrl: config.publicUrl || '',
                    cwd: config.workDir
                });
            }
            try {
                return await tunnel.start();
            } catch (error) {
                channel.send({ type: 'log', message: `tunnel: ${error.message}` });
                return null;
            }
        }
    });
    const info = await node.start();
    return { port: info.port, ips: info.ips, turnPort: info.turnPort };
}

async function stop() {
    if (tunnel) tunnel.stop();
    if (mapper) await Promise.race([mapper.release(), new Promise((resolve) => setTimeout(resolve, 1500))]);
    if (node) await node.stop();
    node = null;
}

channel.on(async (message) => {
    if (!message || typeof message !== 'object') return;
    try {
        if (message.type === 'start') {
            channel.send({ type: 'ready', info: await start(message.config || {}) });
        } else if (message.type === 'find-host') {
            channel.send({ type: 'reply', id: message.id, result: await findHostByCodeOnLan(String(message.code || '')) });
        } else if (message.type === 'stop') {
            await stop();
            channel.send({ type: 'stopped' });
            setTimeout(() => process.exit(0), 50);
        }
    } catch (error) {
        channel.send({ type: 'error', id: message.id, message: error.message });
    }
});

// A Node child (tests) ends with its parent.
if (!process.parentPort) process.on('disconnect', () => stop().finally(() => process.exit(0)));
