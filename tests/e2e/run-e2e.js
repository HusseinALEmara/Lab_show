// End-to-end test of Lab show across a simulated internet, with real Docker containers:
//
//   "internet" 45.67.89.0/24 ── router R1 (NAT + UPnP) ── home network A ── device A
//                            ├─ router R2 (NAT only)  ── home network B ── devices B, C
//                            └─ STUN server
//
// Each device runs the real desktop app (Electron) on a virtual display. Devices B and
// C cannot reach A's home network directly; they only have the link A generated.
// Usage (as root on a machine with Docker): node tests/e2e/run-e2e.js
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const APP = path.resolve(__dirname, '..', '..');
const NODE_DIR = path.resolve(process.execPath, '..', '..');
const WAN = '45.67.89.';
const results = [];
let savedBridgeNf = null;

function docker(args, { allowFail = false } = {}) {
    const out = spawnSync('docker', args, { encoding: 'utf8' });
    if (out.status !== 0 && !allowFail) throw new Error(`docker ${args.join(' ')}\n${out.stderr}`);
    return (out.stdout || '').trim();
}

function cleanup() {
    if (savedBridgeNf !== null) {
        require('node:fs').writeFileSync('/proc/sys/net/bridge/bridge-nf-call-iptables', savedBridgeNf);
        savedBridgeNf = null;
    }
    docker(['rm', '-f', 'lab_r1', 'lab_r2', 'lab_stun', 'lab_a', 'lab_b', 'lab_c'], { allowFail: true });
    for (const net of ['lab_wan', 'lab_lan_a', 'lab_lan_b']) docker(['network', 'rm', net], { allowFail: true });
}

function drive(device, command, args = {}) {
    const output = execFileSync('docker', [
        'exec', '-e', 'NODE_PATH=/opt/node/lib/node_modules', device,
        '/opt/node/bin/node', '/app/tests/e2e/drive.js', command, JSON.stringify(args)
    ], { encoding: 'utf8', timeout: 120000 });
    const line = output.trim().split('\n').pop();
    const parsed = JSON.parse(line);
    if (!parsed.ok) throw new Error(`${device} ${command}: ${parsed.error}`);
    return parsed.result;
}

function check(name, condition, detail) {
    results.push({ name, pass: Boolean(condition), detail });
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
}

function startRouter(name, wanIp, lanNet, lanIp, lanPrefix, upnp) {
    docker(['run', '-d', '--name', name, '--cap-add', 'NET_ADMIN', '--sysctl', 'net.ipv4.ip_forward=1',
        '--network', 'lab_wan', '--ip', wanIp, '-v', `${__dirname}:/e2e:ro`, 'labshow-router', 'sleep', 'infinity']);
    docker(['network', 'connect', '--ip', lanIp, lanNet, name]);
    docker(['exec', '-d', name, '/e2e/router-start.sh', WAN, lanPrefix, upnp]);
}

function startDevice(name, lanNet, ip, routerIp) {
    docker(['run', '-d', '--name', name, '--cap-add', 'NET_ADMIN', '--shm-size', '1g',
        '--network', lanNet, '--ip', ip,
        '-e', `LABSHOW_STUN_URLS=stun:${WAN}20:3478`,
        '-v', `${APP}:/app:ro`, '-v', `${NODE_DIR}:/opt/node:ro`, ...toolMounts(),
        'labshow-device', '/app/tests/e2e/device-start.sh', routerIp]);
}

// The test driver uses Playwright from this machine's global Node modules, which may
// be links into another folder: mount that folder too.
function toolMounts() {
    const fs = require('node:fs');
    const target = fs.realpathSync(path.join(NODE_DIR, 'lib', 'node_modules', 'playwright'));
    const toolsRoot = path.dirname(path.dirname(target));
    return toolsRoot.startsWith(NODE_DIR) ? [] : ['-v', `${toolsRoot}:${toolsRoot}:ro`];
}

function canReach(device, host, port) {
    const script = `const s=require('net').connect(${port},'${host}');` +
        `s.setTimeout(3000);s.on('connect',()=>{console.log('open');process.exit(0)});` +
        `s.on('timeout',()=>{console.log('timeout');process.exit(0)});s.on('error',e=>{console.log(e.code);process.exit(0)});`;
    return docker(['exec', device, '/opt/node/bin/node', '-e', script]);
}

async function main() {
    cleanup();
    docker(['network', 'create', '--subnet', `${WAN}0/24`, 'lab_wan']);
    docker(['network', 'create', '--internal', '--subnet', '192.168.10.0/24', 'lab_lan_a']);
    docker(['network', 'create', '--internal', '--subnet', '192.168.20.0/24', 'lab_lan_b']);
    // A home switch passes every frame between two machines on it. Docker's host
    // firewall also filters frames inside one bridge (bridge-nf-call-iptables) and drops
    // those whose addresses lie outside the network's subnet - the UPnP discovery group,
    // or a packet the router forwards in from the internet. Turn that off for the test;
    // traffic between different networks is still routed and isolated by the host.
    const bridgeNf = '/proc/sys/net/bridge/bridge-nf-call-iptables';
    savedBridgeNf = require('node:fs').readFileSync(bridgeNf, 'utf8').trim();
    require('node:fs').writeFileSync(bridgeNf, '0');
    // A home network passes multicast (UPnP discovery) to the router; Docker's bridges
    // filter it by default ("multicast snooping"), so turn that off on the test LANs.
    for (const net of ['lab_lan_a', 'lab_lan_b']) {
        const id = docker(['network', 'inspect', '-f', '{{.Id}}', net]).slice(0, 12);
        require('node:fs').writeFileSync(`/sys/class/net/br-${id}/bridge/multicast_snooping`, '0');
    }
    startRouter('lab_r1', `${WAN}11`, 'lab_lan_a', '192.168.10.254', '192.168.10.', 'yes');
    startRouter('lab_r2', `${WAN}12`, 'lab_lan_b', '192.168.20.254', '192.168.20.', 'no');
    docker(['run', '-d', '--name', 'lab_stun', '--network', 'lab_wan', '--ip', `${WAN}20`,
        '-v', `${__dirname}:/e2e:ro`, '-v', `${NODE_DIR}:/opt/node:ro`, 'labshow-device', '/opt/node/bin/node', '/e2e/stun-server.js']);
    startDevice('lab_a', 'lab_lan_a', '192.168.10.2', '192.168.10.254');
    startDevice('lab_b', 'lab_lan_b', '192.168.20.2', '192.168.20.254');
    startDevice('lab_c', 'lab_lan_b', '192.168.20.3', '192.168.20.254');

    for (const device of ['lab_a', 'lab_b', 'lab_c']) {
        const ready = drive(device, 'ready');
        check(`${device}: the app opens (Arabic by default)`, ready.lang === 'ar', ready);
    }

    // ---- The network is realistic: B cannot reach A's home network directly. ----
    const direct = canReach('lab_b', '192.168.10.2', 9222);
    check('B cannot reach A\'s home network directly (A is behind NAT)', !['open', 'ECONNREFUSED'].includes(direct), direct);

    // ---- Language switch ----
    const lang = drive('lab_a', 'language');
    check('language: Arabic (right to left) -> English (left to right) -> back',
        lang.before.dir === 'rtl' && lang.english.dir === 'ltr' && lang.english.heading === 'Send my screen' &&
        lang.back.dir === 'rtl' && lang.back.heading === lang.before.heading, lang);

    // ---- Scenario 1: A makes a global code; B, behind another NAT, sends its screen. ----
    const code = drive('lab_a', 'createReceive', { mode: 'global' });
    const link = new URL(code.link);
    check('global code: the link carries router R1\'s public address (UPnP opened a port)',
        link.searchParams.get('e').startsWith(`${WAN}11:`) && link.searchParams.get('m') === 'g', { link: code.link, note: code.reachNote });
    const routerPort = Number(link.searchParams.get('e').split(':')[1]);
    check('B can now reach A through R1\'s public address and the opened port',
        canReach('lab_b', `${WAN}11`, routerPort) === 'open');

    const sent = drive('lab_b', 'send', { code: code.code, link: code.link, title: 'Device B - graduation project' });
    check('B starts sending its screen to A with the code and the link', sent.sending, sent);
    check('global connection: B has no "allow key control" button', sent.controlButtonHidden, sent.controlStatus);

    const watched = drive('lab_a', 'watchIncoming', { title: 'Device B' });
    check('A shows B\'s card with B\'s title', watched.cards.some((c) => c.includes('Device B - graduation project')), watched.cards);
    check('A receives B\'s live screen: picture size known and frames keep arriving',
        watched.video.width > 0 && watched.video.framesAfter3s > watched.video.framesAtStart, watched.video);
    check('A cannot send keys over a global connection', watched.keysDisabled, watched.keysStatus);

    const refused = drive('lab_b', 'tryAllowControl');
    check('B forcing "allow control" is refused by the server in global mode', /global|العالمي/.test(refused.controlStatus), refused);

    const senderLive = drive('lab_b', 'senderState');
    check('B sees that A is watching', /يشاهد|watching/.test(senderLive.live), senderLive);

    // ---- Scenario 2: A starts a global public broadcast while still receiving B. ----
    const room = drive('lab_a', 'startRoom', { mode: 'global', title: 'Networks lecture', name: 'Host A' });
    const roomLink = new URL(room.link);
    check('public broadcast: link with R1\'s public address and a token',
        roomLink.searchParams.get('k') === 'r' && roomLink.searchParams.get('e').startsWith(`${WAN}11:`) &&
        roomLink.searchParams.get('t'), room);
    check('while the public broadcast runs, A\'s private "send" is blocked (one outgoing broadcast per device)', room.sendBlocked);

    const bRoom = drive('lab_b', 'joinRoom', { code: room.code, link: room.link, name: 'Sara' });
    check('B joins the public broadcast and sees A\'s live screen',
        bRoom.video.width > 0 && bRoom.video.framesAfter3s > bRoom.video.framesAtStart, bRoom);
    const cRoom = drive('lab_c', 'joinRoom', { code: room.code, link: room.link, name: 'Omar' });
    check('C joins too and sees A\'s live screen',
        cRoom.video.width > 0 && cRoom.video.framesAfter3s > cRoom.video.framesAtStart, cRoom);

    const stillReceiving = drive('lab_a', 'watchIncoming', { title: 'Device B' });
    check('A keeps receiving B\'s private broadcast while broadcasting publicly',
        stillReceiving.video.framesAfter3s > stillReceiving.video.framesAtStart, stillReceiving.video);

    drive('lab_b', 'roomComment', { text: 'Can you repeat slide 3?' });
    drive('lab_a', 'roomComment', { owner: true, text: 'Sure, one moment' });
    const cView = drive('lab_c', 'roomState', { waitMs: 800 });
    const aView = drive('lab_a', 'roomState', { owner: true });
    check('comments reach everyone in order', JSON.stringify(cView.comments) === JSON.stringify(['Can you repeat slide 3?', 'Sure, one moment']) &&
        JSON.stringify(aView.comments) === JSON.stringify(cView.comments), { c: cView.comments, a: aView.comments });
    check('participants list shows the host and both viewers',
        ['Host A', 'Sara', 'Omar'].every((n) => aView.participants.includes(n)), aView.participants);

    // Voices: only B's microphone is on. C must hear B (through A's mix), and so must A.
    const cBefore = drive('lab_c', 'audio', { ms: 3000 });
    drive('lab_b', 'mic');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const cAfter = drive('lab_c', 'audio', { ms: 4000 });
    const aHears = drive('lab_a', 'ownerHears');
    const energyGain = (r) => (r.after[0] ? r.after[0].energy : 0) - (r.before[0] ? r.before[0].energy : 0);
    const silentGain = energyGain(cBefore);
    const cGain = energyGain(cAfter);

    check('voices: with B\'s microphone on, C hears B (energy rises over silence)', cGain > silentGain * 5 + 1e-4,
        { silentGain, cGain });
    check('voices: the host hears B (loudness of B\'s voice at the host)', aHears.loudest > 0.01, aHears);
    const mics = drive('lab_c', 'roomState');
    check('participants see B\'s microphone is on', mics.micOn >= 1, mics);

    // ---- Scenario 3: local network. B makes a local code; C (same home network) sends
    // with the code only - found by UDP discovery - and may allow key control. B keeps
    // its own outgoing broadcast to A and its seat in the public broadcast meanwhile.
    const local = drive('lab_b', 'createReceive', { mode: 'local' });
    check('local code: the link points at B\'s address on its home network',
        new URL(local.link).searchParams.get('e').startsWith('192.168.20.2:') && new URL(local.link).searchParams.get('m') === 'l', local.link);
    const cSend = drive('lab_c', 'send', { code: local.code, title: 'Device C' });
    check('C sends to B with the code only (found on the local network)', cSend.sending, cSend);
    check('local connection: C has the "allow key control" button', !cSend.controlButtonHidden, cSend);
    const bWatch = drive('lab_b', 'watchIncoming', { title: 'Device C' });
    check('B receives C\'s live screen', bWatch.video.width > 0 && bWatch.video.framesAfter3s > bWatch.video.framesAtStart, bWatch.video);
    check('B\'s keys stay off until C allows them', bWatch.keysDisabled, bWatch.keysStatus);
    const allowed = drive('lab_c', 'allowControl');
    const keys = drive('lab_b', 'keysState');
    check('after C allows control, B\'s key buttons turn on', !keys.keysDisabled, { allowed, keys });
    const bStill = drive('lab_b', 'senderState');
    check('B is still sending its own screen to A meanwhile', /يبث|Live/.test(bStill.pill), bStill);

    const notif = drive('lab_a', 'notifications');
    check('"block notifications" answers clearly on a non-Windows system', /Windows/.test(notif.status), notif);

    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    return failed.length === 0;
}

main().then((ok) => {
    if (!process.env.KEEP) cleanup();
    process.exit(ok ? 0 : 1);
}).catch((error) => {
    console.error('E2E error:', error.message);
    for (const device of ['lab_a', 'lab_b', 'lab_c']) {
        console.error(`--- ${device} electron log ---`);
        console.error(docker(['exec', device, 'tail', '-20', '/tmp/electron.log'], { allowFail: true }));
    }
    if (!process.env.KEEP) cleanup();
    process.exit(1);
});
