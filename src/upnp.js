const dgram = require('node:dgram');
const http = require('node:http');
const os = require('node:os');

// A minimal UPnP Internet Gateway Device client (UPnP IGD v1/v2, the interface home
// routers expose for "automatic port forwarding"): find the router with SSDP, ask it
// for the public address, and map one TCP port to this computer. This is what makes a
// global link reachable from the internet while this device stays the server of its
// own broadcast.
const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
    'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
    'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
    'urn:schemas-upnp-org:service:WANIPConnection:1',
    'urn:schemas-upnp-org:service:WANIPConnection:2',
    'urn:schemas-upnp-org:service:WANPPPConnection:1'
];
const SERVICE_PATTERN = /urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:\d/;
const LEASE_SECONDS = 7200;

function ipv4ToNumber(address) {
    const parts = String(address).split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    return parts.reduce((value, part) => ((value << 8) | part) >>> 0, 0);
}

// Addresses that are not reachable from the internet: private ranges, carrier-grade
// NAT (100.64.0.0/10, the address many mobile and fibre providers give routers),
// loopback, link-local.
function isNonPublicIPv4(address) {
    const n = ipv4ToNumber(address);
    if (n === null) return true;
    const inRange = (base, bits) => (n >>> (32 - bits)) === (ipv4ToNumber(base) >>> (32 - bits));
    return inRange('10.0.0.0', 8) || inRange('172.16.0.0', 12) || inRange('192.168.0.0', 16) ||
        inRange('100.64.0.0', 10) || inRange('127.0.0.0', 8) || inRange('169.254.0.0', 16) ||
        inRange('0.0.0.0', 8);
}

function xmlValue(xml, tag) {
    const match = new RegExp(`<(?:[A-Za-z0-9]+:)?${tag}>([^<]*)</(?:[A-Za-z0-9]+:)?${tag}>`).exec(xml);
    return match ? match[1].trim() : null;
}

function escapeXml(value) {
    return String(value).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function httpRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 3000 } = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request(url, { method, headers, timeout: timeoutMs }, (response) => {
            let data = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                data += chunk;
                if (data.length > 512 * 1024) request.destroy(new Error('response too large'));
            });
            response.on('end', () => resolve({ status: response.statusCode, body: data }));
        });
        request.on('timeout', () => request.destroy(new Error('timeout')));
        request.on('error', reject);
        if (body) request.write(body);
        request.end();
    });
}

// Picks this computer's address on the same subnet as the router.
function localAddressFor(gatewayHost) {
    const gateway = ipv4ToNumber(gatewayHost);
    let fallback = null;
    for (const interfaces of Object.values(os.networkInterfaces())) {
        for (const iface of interfaces || []) {
            if (iface.family !== 'IPv4' || iface.internal) continue;
            fallback = fallback || iface.address;
            const local = ipv4ToNumber(iface.address);
            const mask = ipv4ToNumber(iface.netmask);
            if (gateway !== null && local !== null && mask !== null && (gateway & mask) === (local & mask)) {
                return iface.address;
            }
        }
    }
    return fallback;
}

function searchGateway({ ssdpAddress, ssdpPort, timeoutMs }) {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');
        let done = false;
        const finish = (location) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { socket.close(); } catch { /* already closed */ }
            resolve(location);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        socket.on('message', (msg) => {
            const text = msg.toString();
            if (!/^HTTP\/1\.1 200/i.test(text)) return;
            const location = /^location:\s*(\S+)/im.exec(text);
            if (location) finish(location[1]);
        });
        socket.on('error', () => finish(null));
        socket.bind(() => {
            for (const st of SEARCH_TARGETS) {
                const message = [
                    'M-SEARCH * HTTP/1.1',
                    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
                    'MAN: "ssdp:discover"',
                    'MX: 2',
                    `ST: ${st}`,
                    '', ''
                ].join('\r\n');
                socket.send(Buffer.from(message), ssdpPort, ssdpAddress);
            }
        });
    });
}

async function readGateway(location) {
    const description = await httpRequest(location);
    if (description.status !== 200) throw new Error(`gateway description HTTP ${description.status}`);
    const services = description.body.split(/<service>/i).slice(1);
    for (const block of services) {
        const type = xmlValue(block, 'serviceType');
        const control = xmlValue(block, 'controlURL');
        if (type && control && SERVICE_PATTERN.test(type)) {
            const base = xmlValue(description.body, 'URLBase') || location;
            return { serviceType: type, controlUrl: new URL(control, base).toString(), host: new URL(location).hostname };
        }
    }
    throw new Error('no WAN connection service on the gateway');
}

async function soap(gateway, action, args = {}) {
    const argXml = Object.entries(args).map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`).join('');
    const body = '<?xml version="1.0"?>' +
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
        `<u:${action} xmlns:u="${gateway.serviceType}">${argXml}</u:${action}>` +
        '</s:Body></s:Envelope>';
    const response = await httpRequest(gateway.controlUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'text/xml; charset="utf-8"',
            SOAPAction: `"${gateway.serviceType}#${action}"`,
            'Content-Length': Buffer.byteLength(body)
        },
        body
    });
    if (response.status !== 200) {
        const error = new Error(`${action} failed (${xmlValue(response.body, 'errorCode') || response.status})`);
        error.upnpCode = Number(xmlValue(response.body, 'errorCode')) || null;
        throw error;
    }
    return response.body;
}

function createPortMapper({
    ssdpAddress = SSDP_ADDRESS,
    ssdpPort = SSDP_PORT,
    timeoutMs = 2500,
    description = 'Lab show',
    random = Math.random
} = {}) {
    let gateway = null;
    const mappings = new Map(); // "TCP:port" -> { protocol, internalPort, externalPort, ip, renewTimer }

    async function findGateway() {
        if (gateway) return gateway;
        const location = await searchGateway({ ssdpAddress, ssdpPort, timeoutMs });
        if (!location) throw Object.assign(new Error('no UPnP gateway answered'), { reason: 'upnp-unavailable' });
        gateway = await readGateway(location);
        return gateway;
    }

    async function addMapping(externalPort, internalPort, internalClient, protocol) {
        const args = (lease) => ({
            NewRemoteHost: '',
            NewExternalPort: externalPort,
            NewProtocol: protocol,
            NewInternalPort: internalPort,
            NewInternalClient: internalClient,
            NewEnabled: 1,
            NewPortMappingDescription: description,
            NewLeaseDuration: lease
        });
        try {
            await soap(gateway, 'AddPortMapping', args(LEASE_SECONDS));
            return LEASE_SECONDS;
        } catch (error) {
            // 725: OnlyPermanentLeasesSupported (common on older routers).
            if (error.upnpCode !== 725) throw error;
            await soap(gateway, 'AddPortMapping', args(0));
            return 0;
        }
    }

    // Maps internalPort (TCP or UDP) and returns { reachable, ip, port, reason }.
    async function map(internalPort, protocol = 'TCP') {
        protocol = protocol === 'UDP' ? 'UDP' : 'TCP';
        const existing = mappings.get(`${protocol}:${internalPort}`);
        if (existing) return { reachable: true, ip: existing.ip, port: existing.externalPort };
        try {
            await findGateway();
            const ip = xmlValue(await soap(gateway, 'GetExternalIPAddress'), 'NewExternalIPAddress');
            if (!ip || isNonPublicIPv4(ip)) {
                // The router itself sits behind another NAT (often carrier-grade NAT):
                // a mapping here would not make this device reachable from the internet.
                return { reachable: false, ip, reason: 'cgnat' };
            }
            const internalClient = localAddressFor(gateway.host);
            const candidates = [internalPort];
            for (let i = 0; i < 4; i++) candidates.push(20000 + Math.floor(random() * 40000));
            let lastError = null;
            for (const externalPort of candidates) {
                try {
                    const lease = await addMapping(externalPort, internalPort, internalClient, protocol);
                    const mapping = { protocol, internalPort, externalPort, ip, renewTimer: null };
                    if (lease) {
                        mapping.renewTimer = setInterval(() => {
                            addMapping(externalPort, internalPort, internalClient, protocol).catch(() => {});
                        }, (lease / 2) * 1000);
                        mapping.renewTimer.unref?.();
                    }
                    mappings.set(`${protocol}:${internalPort}`, mapping);
                    return { reachable: true, ip, port: externalPort };
                } catch (error) {
                    lastError = error;
                    // 718: ConflictInMappingEntry - the port is taken; try another one.
                    if (error.upnpCode !== 718) break;
                }
            }
            return { reachable: false, ip, reason: 'upnp-refused', detail: lastError && lastError.message };
        } catch (error) {
            return { reachable: false, reason: error.reason || 'upnp-unavailable', detail: error.message };
        }
    }

    async function release() {
        const current = Array.from(mappings.values());
        mappings.clear();
        for (const mapping of current) {
            if (mapping.renewTimer) clearInterval(mapping.renewTimer);
            try {
                await soap(gateway, 'DeletePortMapping', {
                    NewRemoteHost: '', NewExternalPort: mapping.externalPort, NewProtocol: mapping.protocol
                });
            } catch (error) {
                /* the router may already have dropped it */
            }
        }
    }

    return { map, release, get mappings() { return Array.from(mappings.values(), (m) => ({ ...m, renewTimer: undefined })); } };
}

module.exports = { createPortMapper, isNonPublicIPv4, localAddressFor, SEARCH_TARGETS };
