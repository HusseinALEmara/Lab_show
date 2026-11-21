// UPnP port mapping against a fake home router (SSDP on a test port + the IGD SOAP
// service over HTTP), and the notification guard against a fake `reg` command.
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const http = require('node:http');

const { createPortMapper, isNonPublicIPv4 } = require('../src/upnp');
const { createNotificationGuard, KEY } = require('../src/notifications');

async function fakeRouter({ externalIp = '203.0.113.9', takenPorts = [], permanentOnly = false } = {}) {
    const calls = [];
    const mappings = new Map();
    const server = http.createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
            if (request.url === '/desc.xml') {
                response.writeHead(200, { 'Content-Type': 'text/xml' });
                response.end(`<?xml version="1.0"?><root><device><deviceList><device><serviceList>
                    <service><serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType><controlURL>/common</controlURL></service>
                    <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service>
                    </serviceList></device></deviceList></device></root>`);
                return;
            }
            const action = /#(\w+)"/.exec(request.headers.soapaction || '')[1];
            const arg = (name) => (new RegExp(`<${name}>([^<]*)</${name}>`).exec(body) || [])[1];
            calls.push({ action, port: arg('NewExternalPort'), lease: arg('NewLeaseDuration'), client: arg('NewInternalClient') });
            const fault = (code) => {
                response.writeHead(500, { 'Content-Type': 'text/xml' });
                response.end(`<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
            };
            if (action === 'GetExternalIPAddress') {
                response.writeHead(200);
                response.end(`<s:Envelope><s:Body><u:GetExternalIPAddressResponse><NewExternalIPAddress>${externalIp}</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>`);
            } else if (action === 'AddPortMapping') {
                if (takenPorts.includes(Number(arg('NewExternalPort')))) return fault(718);
                if (permanentOnly && arg('NewLeaseDuration') !== '0') return fault(725);
                mappings.set(Number(arg('NewExternalPort')), Number(arg('NewInternalPort')));
                response.writeHead(200);
                response.end('<s:Envelope><s:Body><u:AddPortMappingResponse/></s:Body></s:Envelope>');
            } else if (action === 'DeletePortMapping') {
                mappings.delete(Number(arg('NewExternalPort')));
                response.writeHead(200);
                response.end('<s:Envelope><s:Body/></s:Envelope>');
            } else {
                fault(401);
            }
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const httpPort = server.address().port;

    const ssdp = dgram.createSocket('udp4');
    let searches = 0;
    ssdp.on('message', (msg, rinfo) => {
        if (!msg.toString().startsWith('M-SEARCH')) return;
        searches++;
        ssdp.send(Buffer.from([
            'HTTP/1.1 200 OK',
            'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
            `LOCATION: http://127.0.0.1:${httpPort}/desc.xml`,
            '', ''
        ].join('\r\n')), rinfo.port, rinfo.address);
    });
    await new Promise((resolve) => ssdp.bind(0, '127.0.0.1', resolve));
    return {
        ssdpPort: ssdp.address().port,
        calls,
        mappings,
        get searches() { return searches; },
        close: () => new Promise((resolve) => { ssdp.close(); server.close(resolve); })
    };
}

const mapperFor = (router, extra = {}) => createPortMapper({
    ssdpAddress: '127.0.0.1', ssdpPort: router.ssdpPort, timeoutMs: 800, ...extra
});

test('UPnP: finds the router, reads the public address and opens the same port', async () => {
    const router = await fakeRouter();
    try {
        const mapper = mapperFor(router);
        const result = await mapper.map(45678);
        assert.deepEqual(result, { reachable: true, ip: '203.0.113.9', port: 45678 });
        assert.equal(router.mappings.get(45678), 45678);
        const add = router.calls.find((c) => c.action === 'AddPortMapping');
        assert.equal(add.lease, '7200');
        assert.ok(add.client, 'the mapping points at this computer');

        const again = await mapper.map(45678);
        assert.equal(again.port, 45678, 'an existing mapping is reused');
        assert.equal(router.calls.filter((c) => c.action === 'AddPortMapping').length, 1);

        await mapper.release();
        assert.equal(router.mappings.size, 0, 'the port is closed again on release');
    } finally {
        await router.close();
    }
});

test('UPnP: a taken port gets a different external port that maps back to ours', async () => {
    const router = await fakeRouter({ takenPorts: [41000] });
    try {
        const result = await mapperFor(router, { random: () => 0.25 }).map(41000);
        assert.equal(result.reachable, true);
        assert.equal(result.port, 30000);
        assert.equal(router.mappings.get(30000), 41000);
    } finally {
        await router.close();
    }
});

test('UPnP: routers that only accept permanent mappings still work', async () => {
    const router = await fakeRouter({ permanentOnly: true });
    try {
        const result = await mapperFor(router).map(42000);
        assert.equal(result.reachable, true);
        assert.deepEqual(router.calls.filter((c) => c.action === 'AddPortMapping').map((c) => c.lease), ['7200', '0']);
    } finally {
        await router.close();
    }
});

test('UPnP: a router behind carrier-grade NAT is reported, not trusted', async () => {
    const router = await fakeRouter({ externalIp: '100.72.14.3' });
    try {
        const result = await mapperFor(router).map(43000);
        assert.equal(result.reachable, false);
        assert.equal(result.reason, 'cgnat');
        assert.equal(router.mappings.size, 0, 'no useless mapping is left behind');
    } finally {
        await router.close();
    }
});

test('UPnP: no router answering means "unavailable", quickly', async () => {
    const silent = dgram.createSocket('udp4');
    await new Promise((resolve) => silent.bind(0, '127.0.0.1', resolve));
    try {
        const started = Date.now();
        const result = await createPortMapper({
            ssdpAddress: '127.0.0.1', ssdpPort: silent.address().port, timeoutMs: 300
        }).map(44000);
        assert.deepEqual({ reachable: result.reachable, reason: result.reason }, { reachable: false, reason: 'upnp-unavailable' });
        assert.ok(Date.now() - started < 2000);
    } finally {
        silent.close();
    }
});

test('public and non-public addresses', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '100.64.0.1', '100.127.1.1', '127.0.0.1', '169.254.1.1', 'x']) {
        assert.equal(isNonPublicIPv4(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '203.0.113.9', '172.32.0.1', '100.128.0.1', '185.10.10.10']) {
        assert.equal(isNonPublicIPv4(ip), false, ip);
    }
});

function fakeReg(initial) {
    const state = { value: initial, calls: [] };
    state.run = async (args) => {
        state.calls.push(args.join(' '));
        if (args[0] === 'query') {
            if (state.value === null) throw new Error('not found');
            return `\n${KEY}\n    ToastEnabled    REG_DWORD    0x${state.value.toString(16)}\n`;
        }
        if (args[0] === 'add') state.value = Number(args[args.indexOf('/d') + 1]);
        if (args[0] === 'delete') state.value = null;
        return '';
    };
    return state;
}

test('notifications: hidden while broadcasting, then restored to the user’s own value', async () => {
    const reg = fakeReg(1);
    const guard = createNotificationGuard({ platform: 'win32', run: reg.run });
    assert.deepEqual(await guard.suppress(), { ok: true, active: true });
    assert.equal(reg.value, 0);
    assert.equal(guard.active, true);
    await guard.suppress();
    assert.deepEqual(await guard.restore(), { ok: true, active: false });
    assert.equal(reg.value, 1);

    const off = fakeReg(0);
    const guard2 = createNotificationGuard({ platform: 'win32', run: off.run });
    await guard2.suppress();
    await guard2.restore();
    assert.equal(off.value, 0, 'a user who had them off keeps them off');

    const absent = fakeReg(null);
    const guard3 = createNotificationGuard({ platform: 'win32', run: absent.run });
    await guard3.suppress();
    assert.equal(absent.value, 0);
    await guard3.restore();
    assert.equal(absent.value, null, 'a value that did not exist is removed again');
});

test('notifications: other systems are told it is unsupported and nothing runs', async () => {
    const reg = fakeReg(1);
    const guard = createNotificationGuard({ platform: 'linux', run: reg.run });
    assert.deepEqual(await guard.suppress(), { ok: false, error: 'unsupported' });
    assert.equal(reg.calls.length, 0);
});
