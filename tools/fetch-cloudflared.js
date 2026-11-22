// Downloads Cloudflare's cloudflared program for the release build and refuses it unless
// its SHA-256 matches the value Cloudflare publishes in the release notes (and GitHub's
// own digest for the file, when present).
// Usage: node tools/fetch-cloudflared.js <asset-name> <output-path>
//   e.g. node tools/fetch-cloudflared.js cloudflared-windows-amd64.exe resources/cloudflared.exe
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const [assetName, output] = process.argv.slice(2);
if (!assetName || !output) {
    console.error('usage: node tools/fetch-cloudflared.js <asset-name> <output-path>');
    process.exit(2);
}

async function main() {
    const headers = { 'User-Agent': 'lab-show-build', Accept: 'application/vnd.github+json' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const response = await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', { headers });
    if (!response.ok) throw new Error(`release lookup failed: HTTP ${response.status}`);
    const release = await response.json();
    const asset = (release.assets || []).find((a) => a.name === assetName);
    if (!asset) throw new Error(`${assetName} not found in ${release.tag_name}`);

    const published = new RegExp(`${assetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*([0-9a-f]{64})`, 'i')
        .exec(release.body || '');
    const githubDigest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
    if (!published && !githubDigest) throw new Error('no published SHA-256 to check against');

    const download = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'lab-show-build' } });
    if (!download.ok) throw new Error(`download failed: HTTP ${download.status}`);
    const data = Buffer.from(await download.arrayBuffer());
    const actual = crypto.createHash('sha256').update(data).digest('hex');
    for (const expected of [published && published[1], githubDigest && githubDigest[1]].filter(Boolean)) {
        if (expected.toLowerCase() !== actual) throw new Error(`SHA-256 mismatch: expected ${expected}, got ${actual}`);
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, data, { mode: 0o755 });
    console.log(`${assetName} ${release.tag_name} sha256=${actual} -> ${output}`);
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
