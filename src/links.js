// Session links: how a device tells another where it is and how to join it.
//
// A link is a real address of the device that made it (that device is the server of its
// own session): opening it in a browser reaches that device, which answers with a page
// about the session. Its form is
//     <web address of the device>/j?k=...&m=...&c=CODE&e=IP:PORT&t=TOKEN
// where the web address is the device's public tunnel (https://....trycloudflare.com or
// an institution's own domain) or, without a tunnel, http://<router public IP>:<port>.
// `e` also carries the direct address, tried first because it is faster.
//
// Shared by the Node side and the interface (loaded as a plain script there).
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.LabShowLinks = api;
}(typeof self !== 'undefined' ? self : this, () => {
    const LEGACY_BASE = 'https://labshow.link/j';
    const CODE_PATTERN = /^(?:\d{6}|[A-Z2-9]{12})$/;
    const TOKEN_PATTERN = /^[A-Z2-9]{12}$/;
    const ENDPOINT_PATTERN = /^([A-Za-z0-9.-]+):(\d{2,5})$/;

    function cleanWebUrl(value) {
        if (!value) return '';
        try {
            const url = new URL(value);
            if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
            return url.origin;
        } catch (error) {
            return '';
        }
    }

    function buildLink({ kind = 'send', mode = 'local', code, endpoint, token = '', username = '', webUrl = '' }) {
        const params = new URLSearchParams({ k: kind === 'room' ? 'r' : 's', m: mode === 'global' ? 'g' : 'l', c: code });
        if (endpoint) params.set('e', endpoint);
        if (token) params.set('t', token);
        if (username) params.set('u', username);
        const origin = cleanWebUrl(webUrl) || (endpoint ? `http://${endpoint}` : '');
        return `${origin ? `${origin}/j` : LEGACY_BASE}?${params.toString()}`;
    }

    // Returns { kind, mode, code, host, port, webUrl, token, username } or null when the
    // text is not a Lab show link. Older links (labshow.link, without k/m) still parse.
    function parseLink(raw) {
        let url;
        try {
            url = new URL(String(raw || '').trim());
        } catch (error) {
            return null;
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        if (!/\/j\/?$/.test(url.pathname)) return null;
        const p = url.searchParams;
        const code = String(p.get('c') || '').trim().toUpperCase();
        const token = String(p.get('t') || '').trim().toUpperCase();
        if (!CODE_PATTERN.test(code)) return null;
        if (token && !TOKEN_PATTERN.test(token)) return null;

        let host = null;
        let port = null;
        const endpointText = String(p.get('e') || '').trim();
        if (endpointText) {
            const endpoint = ENDPOINT_PATTERN.exec(endpointText);
            if (!endpoint) return null;
            port = Number(endpoint[2]);
            if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
            host = endpoint[1];
        }
        const webUrl = url.hostname === 'labshow.link' ? '' : url.origin;
        if (!host && !webUrl) return null;

        const kind = p.get('k') === 'r' ? 'room' : 'send';
        const mode = p.get('m') === 'g' || (!p.get('m') && token) ? 'global' : 'local';
        if ((kind === 'room' || mode === 'global') && !token) return null;
        return { kind, mode, code, host, port, webUrl, token, username: String(p.get('u') || '').trim() };
    }

    // Addresses to try, in order: the direct one first (fastest), then the web address
    // (the tunnel), which also works behind firewalls that allow only port 443.
    function connectTargets(parsed) {
        const targets = [];
        if (parsed && parsed.host && parsed.port) targets.push(`http://${parsed.host}:${parsed.port}`);
        if (parsed && parsed.webUrl && !targets.includes(parsed.webUrl)) targets.push(parsed.webUrl);
        return targets;
    }

    return { LEGACY_BASE, CODE_PATTERN, TOKEN_PATTERN, buildLink, parseLink, connectTargets };
}));
