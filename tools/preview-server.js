const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createLocalHostNode } = require('../src/server');

const ROOT = path.resolve(__dirname, '..');
const PREVIEW_PORT = 4173;

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.min.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
};

function contentType(filePath) {
    if (filePath.endsWith('.min.js')) return CONTENT_TYPES['.min.js'];
    return CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream';
}

function safeResolve(relativePath) {
    const target = path.resolve(ROOT, '.' + relativePath);
    return target.startsWith(ROOT) ? target : null;
}

function readFile(filePath, encoding = null) {
    return new Promise((resolve, reject) => {
        fs.readFile(filePath, encoding, (error, data) => error ? reject(error) : resolve(data));
    });
}

async function buildPreviewHtml(signalingPort) {
    const template = await readFile(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
    const stub = `<script>
window.electronAPI = {
  getHostInfo: async () => ({ port: ${signalingPort}, ips: ['127.0.0.1'] }),
  findHostByCode: async () => ({ ip: '127.0.0.1', port: ${signalingPort} }),
  setFullScreen() {}, setWindowSizeMode() {}, showWindow() {},
  setOutgoingState() {}, setStudentControlEnabled() {},
  applyControlKey: async () => ({ ok: true, message: 'المعاينة: تم استلام المفتاح.' }),
  onTrayStopBroadcast() {}, onTrayTogglePause() {}, onTrayToggleControl() {}, onFloatingClosed() {}
};
</script>`;
    return template
        .replace('<head>', '<head>\n        <base href="/renderer/" />')
        .replace('<script src="app.js"></script>', `${stub}\n    <script src="app.js"></script>`);
}

async function main() {
    const signaling = createLocalHostNode();
    const info = await signaling.start();

    const server = http.createServer(async (request, response) => {
        const urlPath = decodeURIComponent((request.url || '/').split('?')[0]);
        try {
            if (urlPath === '/preview' || urlPath === '/renderer/__harness.html') {
                const html = await buildPreviewHtml(info.port);
                response.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'] });
                response.end(html);
                return;
            }
            const relative = urlPath === '/' ? '/renderer/index.html' : urlPath;
            const filePath = safeResolve(relative);
            if (!filePath) {
                response.writeHead(403);
                response.end('Forbidden');
                return;
            }
            const data = await readFile(filePath);
            response.writeHead(200, { 'Content-Type': contentType(filePath) });
            response.end(data);
        } catch (error) {
            if (response.headersSent) {
                response.end();
                return;
            }
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('الملف غير موجود');
        }
    });

    server.listen(PREVIEW_PORT, '127.0.0.1', () => {
        console.log(`معاينة Lab show: http://127.0.0.1:${PREVIEW_PORT}/preview`);
        console.log(`خادم الإشارات المحلي: ${info.port}`);
    });

    const shutdown = async () => {
        server.close();
        await signaling.stop();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((error) => {
    console.error('تعذر تشغيل المعاينة:', error);
    process.exit(1);
});
