// Session links: how a device tells another where it is and how to join it.
// A link carries the code, the address of the device that made it (that device is
// the server of its own session), and a secret token. Shared by the Node side and
// the interface (loaded as a plain script there).
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.LabShowLinks = api;
}(typeof self !== 'undefined' ? self : this, () => {
    const LINK_BASE = 'https://labshow.link/j';
    const CODE_PATTERN = /^(?:\d{6}|[A-Z2-9]{12})$/;
    const TOKEN_PATTERN = /^[A-Z2-9]{12}$/;
    const ENDPOINT_PATTERN = /^([A-Za-z0-9.-]+):(\d{2,5})$/;

    function buildLink({ kind = 'send', mode = 'local', code, endpoint, token = '', username = '' }) {
        const params = new URLSearchParams({
            k: kind === 'room' ? 'r' : 's',
            m: mode === 'global' ? 'g' : 'l',
            c: code,
            e: endpoint
        });
        if (token) params.set('t', token);
        if (username) params.set('u', username);
        return `${LINK_BASE}?${params.toString()}`;
    }

    // Returns { kind, mode, code, host, port, token, username } or null when the link
    // is not a Lab show link. Older links without k/m are send links; with a token
    // they were global.
    function parseLink(raw) {
        let url;
        try {
            url = new URL(String(raw || '').trim());
        } catch (error) {
            return null;
        }
        const p = url.searchParams;
        const code = String(p.get('c') || '').trim().toUpperCase();
        const token = String(p.get('t') || '').trim().toUpperCase();
        const endpoint = ENDPOINT_PATTERN.exec(String(p.get('e') || '').trim());
        if (!CODE_PATTERN.test(code) || !endpoint) return null;
        const port = Number(endpoint[2]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
        if (token && !TOKEN_PATTERN.test(token)) return null;
        const kind = p.get('k') === 'r' ? 'room' : 'send';
        const mode = p.get('m') === 'g' || (!p.get('m') && token) ? 'global' : 'local';
        if ((kind === 'room' || mode === 'global') && !token) return null;
        return { kind, mode, code, host: endpoint[1], port, token, username: String(p.get('u') || '').trim() };
    }

    return { LINK_BASE, CODE_PATTERN, TOKEN_PATTERN, buildLink, parseLink };
}));
