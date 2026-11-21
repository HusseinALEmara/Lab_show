// A minimal STUN server (RFC 5389 Binding requests only) for the end-to-end test:
// it tells each device the address and port its router gave it on the "internet".
const dgram = require('node:dgram');

const MAGIC = 0x2112a442;
const socket = dgram.createSocket('udp4');
socket.on('message', (msg, rinfo) => {
    if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001 || msg.readUInt32BE(4) !== MAGIC) return;
    const transactionId = msg.subarray(8, 20);
    const attr = Buffer.alloc(12);
    attr.writeUInt16BE(0x0020, 0); // XOR-MAPPED-ADDRESS
    attr.writeUInt16BE(8, 2);
    attr.writeUInt8(0, 4);
    attr.writeUInt8(0x01, 5); // IPv4
    attr.writeUInt16BE(rinfo.port ^ (MAGIC >>> 16), 6);
    const ip = rinfo.address.split('.').map(Number);
    const ipNumber = ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) >>> 0;
    attr.writeUInt32BE((ipNumber ^ MAGIC) >>> 0, 8);
    const header = Buffer.alloc(20);
    header.writeUInt16BE(0x0101, 0); // Binding success response
    header.writeUInt16BE(attr.length, 2);
    header.writeUInt32BE(MAGIC, 4);
    transactionId.copy(header, 8);
    socket.send(Buffer.concat([header, attr]), rinfo.port, rinfo.address);
});
socket.bind(3478, '0.0.0.0', () => console.log('stun-ready'));
