const PROTOCOL_VERSION = 4;
const MIN_SUPPORTED_VERSION = 2;

function isCompatible(clientVersion, sessionVersion) {
    if (!clientVersion || !sessionVersion) return true; // older clients without version field
    return Number(clientVersion) >= MIN_SUPPORTED_VERSION &&
        Number(sessionVersion) >= MIN_SUPPORTED_VERSION;
}

const protocolApi = { PROTOCOL_VERSION, MIN_SUPPORTED_VERSION, isCompatible };

if (typeof module !== 'undefined' && module.exports) module.exports = protocolApi;
else if (typeof window !== 'undefined') window.LabShowProtocol = protocolApi;
