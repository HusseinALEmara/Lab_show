const dgram = require('node:dgram');
const os = require('node:os');
const { UDP_DISCOVERY_PORT } = require('./server');

// Finds, on the local network, the device that owns a receiving code: a UDP broadcast
// "who has CODE?", answered with that device's port. Returns { ip, port } or null.
function findHostByCodeOnLan(code, { timeoutMs = 1600, port = UDP_DISCOVERY_PORT, targets = null } = {}) {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { socket.close(); } catch { /* already closed */ }
            resolve(result);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        socket.on('message', (msg, rinfo) => {
            const prefix = `LAB_SHOW_MATCH:${code}:`;
            const text = msg.toString();
            if (!text.startsWith(prefix)) return;
            const found = Number(text.slice(prefix.length));
            if (Number.isInteger(found) && found > 0) finish({ ip: rinfo.address, port: found });
        });
        socket.on('error', () => finish(null));
        socket.bind(() => {
            socket.setBroadcast(true);
            const packet = Buffer.from(`LAB_SHOW_FIND:${code}`);
            const addresses = targets || ['255.255.255.255'];
            if (!targets) {
                for (const interfaces of Object.values(os.networkInterfaces())) {
                    for (const iface of interfaces || []) {
                        if (iface.family !== 'IPv4' || iface.internal || !iface.netmask) continue;
                        const ip = iface.address.split('.').map(Number);
                        const mask = iface.netmask.split('.').map(Number);
                        addresses.push(ip.map((part, i) => (part | (~mask[i] & 255))).join('.'));
                    }
                }
            }
            for (const address of addresses) socket.send(packet, port, address);
        });
    });
}

module.exports = { findHostByCodeOnLan };
