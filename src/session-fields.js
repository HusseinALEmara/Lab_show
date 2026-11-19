const MAX_TITLE_LENGTH = 80;
const CODE_PATTERN = /^(?:\d{6}|[A-Z2-9]{12})$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function normalizeCode(value) {
    return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function generateSessionCode(length = 12) {
    const crypto = require('node:crypto');
    const bytes = crypto.randomBytes(length);
    let code = '';
    for (let i = 0; i < length; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return code;
}

function isValidCode(value) {
    return CODE_PATTERN.test(normalizeCode(value));
}

// Broadcast titles are user text: bounded, single-line, and never interpreted.
function normalizeTitle(value, fallback) {
    if (typeof value !== 'string') return fallback;
    const cleaned = value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_TITLE_LENGTH);
    return cleaned || fallback;
}

function normalizeDurationMinutes(value) {
    const minutes = Number(value);
    return Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 480) : null;
}

module.exports = {
    MAX_TITLE_LENGTH,
    normalizeCode,
    isValidCode,
    generateSessionCode,
    normalizeTitle,
    normalizeDurationMinutes
};
