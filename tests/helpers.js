const { io } = require('socket.io-client');

// Connects a Socket.IO client and resolves once the connection is open.
function connect(port, options = {}) {
    return new Promise((resolve, reject) => {
        const socket = io(`http://127.0.0.1:${port}`, {
            transports: ['websocket'],
            forceNew: true,
            reconnection: false,
            timeout: 3000,
            ...options
        });
        socket.once('connect', () => resolve(socket));
        socket.once('connect_error', reject);
    });
}

// Emits an event and waits for the server's acknowledgement.
function ask(socket, event, payload, ms = 5000) {
    return socket.timeout(ms).emitWithAck(event, payload);
}

// Resolves with the next payload of `event`, or rejects after `ms`.
function nextEvent(socket, event, ms = 3000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off(event, handler);
            reject(new Error(`timed out waiting for ${event}`));
        }, ms);
        function handler(payload) {
            clearTimeout(timer);
            resolve(payload);
        }
        socket.once(event, handler);
    });
}

// Resolves true if `event` arrives within `ms`, false otherwise.
function receivesWithin(socket, event, ms = 400) {
    return nextEvent(socket, event, ms).then(() => true, () => false);
}

module.exports = { connect, ask, nextEvent, receivesWithin };
