// Drives the real Lab show app inside one test computer, the way a person would:
// fills fields, presses buttons, and reads what the screen shows. Runs inside the
// device container and talks to Electron over its local debugging port.
// Usage: node drive.js <command> '<json args>'   -> prints one JSON line.
const { chromium } = require('playwright');

const [command, rawArgs] = process.argv.slice(2);
const args = rawArgs ? JSON.parse(rawArgs) : {};

async function connect() {
    for (let i = 0; i < 60; i++) {
        try {
            return await chromium.connectOverCDP('http://127.0.0.1:9222');
        } catch (error) {
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
    throw new Error('Electron debugging port did not open');
}

async function pageMatching(browser, part, timeoutMs = 20000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        for (const context of browser.contexts()) {
            for (const page of context.pages()) {
                if (page.url().includes(part)) return page;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`no page ${part}`);
}

const text = (page, selector) => page.locator(selector).innerText().catch(() => '');

async function videoFrames(page, selector) {
    return page.evaluate((sel) => {
        const video = document.querySelector(sel);
        if (!video || !video.videoWidth) return { width: 0, frames: 0 };
        return { width: video.videoWidth, height: video.videoHeight, frames: video.getVideoPlaybackQuality().totalVideoFrames };
    }, selector);
}

// Waits until the video shows frames, then checks that new frames keep arriving.
async function liveVideo(page, selector, timeoutMs = 45000) {
    const until = Date.now() + timeoutMs;
    let first = { width: 0, frames: 0 };
    while (Date.now() < until) {
        first = await videoFrames(page, selector);
        if (first.width > 0 && first.frames > 0) break;
        await page.waitForTimeout(500);
    }
    await page.waitForTimeout(3000);
    const second = await videoFrames(page, selector);
    return { width: second.width, height: second.height, framesAtStart: first.frames, framesAfter3s: second.frames };
}

async function roomAudio(page) {
    return page.evaluate(async () => {
        const result = [];
        for (const pc of window.labshowRoomDebug.peerConnections()) {
            const stats = await pc.getStats();
            stats.forEach((r) => {
                if (r.type === 'inbound-rtp' && r.kind === 'audio') {
                    result.push({ energy: r.totalAudioEnergy || 0, level: r.audioLevel || 0, bytes: r.bytesReceived || 0 });
                }
            });
        }
        return result;
    });
}

const commands = {
    async ready(browser) {
        const page = await pageMatching(browser, 'index.html');
        await page.waitForSelector('#generateBtn:not([disabled])', { timeout: 30000 });
        return { title: await page.title(), lang: await page.evaluate(() => document.documentElement.lang) };
    },

    async language(browser) {
        const page = await pageMatching(browser, 'index.html');
        const before = { dir: await page.evaluate(() => document.dir), heading: await text(page, '#sendHeading') };
        await page.click('#langToggle');
        const english = { dir: await page.evaluate(() => document.dir), heading: await text(page, '#sendHeading'), receive: await text(page, '#recvHeading') };
        await page.click('#langToggle');
        const back = { dir: await page.evaluate(() => document.dir), heading: await text(page, '#sendHeading') };
        return { before, english, back };
    },

    async createReceive(browser) {
        const page = await pageMatching(browser, 'index.html');
        await page.click(`#networkModeSelect button[data-mode="${args.mode || 'local'}"]`);
        await page.click('#generateBtn');
        await page.waitForSelector('#generatedBox:not([hidden])', { timeout: 30000 });
        return {
            code: (await text(page, '#generatedCode')).trim(),
            link: (await text(page, '#globalLinkText')).trim(),
            reachNote: (await text(page, '#reachNote')).trim(),
            status: await text(page, '#hostStatus')
        };
    },

    async send(browser) {
        const page = await pageMatching(browser, 'index.html');
        await page.fill('#codeInput', args.code || '');
        await page.fill('#sendLinkInput', args.link || '');
        await page.fill('#joinTitleInput', args.title || '');
        await page.click('#approveCodeBtn');
        try {
            await page.waitForSelector('#broadcastCard:not([hidden])', { timeout: 30000 });
        } catch (error) {
            return { sending: false, status: await text(page, '#outgoingStatus') };
        }
        return {
            sending: true,
            pill: await text(page, '#broadcastStatusPill'),
            identity: await text(page, '#studentIdentity'),
            controlButtonHidden: await page.locator('#studentControlToggle').isHidden(),
            controlStatus: await text(page, '#studentControlStatus')
        };
    },

    async senderState(browser) {
        const page = await pageMatching(browser, 'index.html');
        return {
            live: await text(page, '#liveStatusText'),
            pill: await text(page, '#broadcastStatusPill'),
            controlButtonHidden: await page.locator('#studentControlToggle').isHidden()
        };
    },

    async watchIncoming(browser) {
        const page = await pageMatching(browser, 'index.html');
        await page.waitForSelector('.student-card .select-btn:not([disabled])', { timeout: 40000 });
        const cards = await page.locator('.student-card .tile-title').allInnerTexts();
        const index = args.title ? cards.findIndex((c) => c.includes(args.title)) : 0;
        const card = page.locator('.student-card').nth(Math.max(0, index));
        if (!(await card.evaluate((el) => el.classList.contains('selected')))) {
            await card.locator('.select-btn').click({ force: true });
        }
        const video = await liveVideo(page, '#remoteVideo');
        return {
            cards,
            viewerTitle: await text(page, '#viewerTitle'),
            video,
            keysStatus: await text(page, '#teacherControlStatus'),
            keysDisabled: await page.locator('[data-remote-key="Enter"]').isDisabled()
        };
    },

    async allowControl(browser) {
        const page = await pageMatching(browser, 'index.html');
        await page.click('#studentControlToggle');
        await page.waitForTimeout(1500);
        return { controlStatus: await text(page, '#studentControlStatus'), toggle: await text(page, '#studentControlToggle') };
    },

    async keysState(browser) {
        const page = await pageMatching(browser, 'index.html');
        await page.waitForTimeout(1000);
        return {
            keysStatus: await text(page, '#teacherControlStatus'),
            keysDisabled: await page.locator('[data-remote-key="Enter"]').isDisabled()
        };
    },

    async tryAllowControl(browser) {
        const page = await pageMatching(browser, 'index.html');
        // The button is hidden in global mode; press it from script anyway to prove the
        // server refuses too.
        await page.evaluate(() => document.getElementById('studentControlToggle').click());
        await page.waitForTimeout(1500);
        return { controlStatus: await text(page, '#studentControlStatus') };
    },

    async startRoom(browser) {
        const page = await pageMatching(browser, 'index.html');
        await page.fill('#pubTitleInput', args.title || '');
        await page.fill('#pubNameInput', args.name || '');
        await page.click(`#pubNetworkMode button[data-mode="${args.mode || 'local'}"]`);
        await page.click('#pubStartBtn');
        const room = await pageMatching(browser, 'room.html?');
        await room.waitForFunction(() => document.getElementById('roomLink').textContent.includes('labshow.link'), null, { timeout: 40000 });
        return {
            code: (await text(room, '#roomCode')).trim(),
            link: (await text(room, '#roomLink')).trim(),
            reachNote: (await text(room, '#roomReach')).trim(),
            sendBlocked: await page.locator('#approveCodeBtn').isDisabled()
        };
    },

    async joinRoom(browser) {
        const page = await pageMatching(browser, 'index.html');
        await page.fill('#joinCodeInput', args.code || '');
        await page.fill('#joinLinkInput', args.link || '');
        await page.fill('#joinNameInput', args.name || '');
        await page.click('#joinRoomBtn');
        const room = await pageMatching(browser, 'role=viewer');
        const video = await liveVideo(room, '#stageVideo');
        return { title: await text(room, '#roomTitle'), video, status: await text(room, '#roomStatus') };
    },

    async roomComment(browser) {
        const room = await pageMatching(browser, args.owner ? 'role=owner' : 'role=viewer');
        await room.fill('#commentInput', args.text);
        await room.click('#commentSend');
        await room.waitForTimeout(800);
        return { ok: true };
    },

    async roomState(browser) {
        const room = await pageMatching(browser, args.owner ? 'role=owner' : 'role=viewer');
        await room.waitForTimeout(args.waitMs || 500);
        return {
            participants: await room.locator('.participant-name').allInnerTexts(),
            micOn: await room.locator('.mic-dot.on').count(),
            comments: await room.locator('.comment p').allInnerTexts(),
            heading: await text(room, '#participantsHeading')
        };
    },

    async mic(browser) {
        const room = await pageMatching(browser, args.owner ? 'role=owner' : 'role=viewer');
        await room.click('#micBtn');
        await room.waitForTimeout(500);
        return { button: await text(room, '#micBtn') };
    },

    async audio(browser) {
        const room = await pageMatching(browser, args.owner ? 'role=owner' : 'role=viewer');
        const before = await roomAudio(room);
        await room.waitForTimeout(args.ms || 4000);
        const after = await roomAudio(room);
        return { before, after };
    },

    // Which ICE candidates (direct / via STUN) this device can gather.
    async iceProbe(browser) {
        const page = await pageMatching(browser, 'index.html');
        return page.evaluate(async () => {
            const info = await window.electronAPI.getHostInfo();
            const pc = new RTCPeerConnection({ iceServers: info.iceServers });
            pc.createDataChannel('probe');
            const candidates = [];
            pc.onicecandidate = (event) => { if (event.candidate) candidates.push(event.candidate.candidate); };
            await pc.setLocalDescription(await pc.createOffer());
            await new Promise((resolve) => setTimeout(resolve, 3000));
            pc.close();
            return { iceServers: info.iceServers, candidates };
        });
    },

    // The owner's measured loudness of each viewer's voice, sampled for a few seconds.
    async ownerHears(browser) {
        const room = await pageMatching(browser, 'role=owner');
        let loudest = 0;
        for (let i = 0; i < 20; i++) {
            const levels = await room.evaluate(() => window.labshowRoomDebug.voiceLevels());
            loudest = Math.max(loudest, ...levels.map((l) => l.rms), 0);
            await room.waitForTimeout(150);
        }
        return { loudest };
    },

    async notifications(browser) {
        const room = await pageMatching(browser, 'role=owner');
        await room.click('#notifBtn');
        await room.waitForTimeout(800);
        return { status: await text(room, '#roomStatus') };
    }
};

(async () => {
    const browser = await connect();
    try {
        const result = await commands[command](browser);
        process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    } catch (error) {
        process.stdout.write(`${JSON.stringify({ ok: false, error: String(error && error.message || error) })}\n`);
    } finally {
        // Leave the app running: only drop this debugging connection.
        process.exit(0);
    }
})();
