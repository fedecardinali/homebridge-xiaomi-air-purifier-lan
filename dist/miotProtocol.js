"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MiotProtocol = exports.MIIO_HANDSHAKE_PACKET = void 0;
exports.deriveMiioKeyMaterial = deriveMiioKeyMaterial;
exports.encodeMiioPacket = encodeMiioPacket;
exports.decodeMiioPacket = decodeMiioPacket;
const node_crypto_1 = require("node:crypto");
const node_dgram_1 = require("node:dgram");
const MIIO_PORT = 54321;
const HANDSHAKE_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 4000;
const HANDSHAKE_MAX_AGE_MS = 120000;
const RECOVERABLE_ERROR_CODES = new Set([-30001, -9999]);
exports.MIIO_HANDSHAKE_PACKET = Buffer.from('21310020ffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'hex');
function deriveMiioKeyMaterial(tokenHex) {
    if (!/^[0-9a-fA-F]{32}$/.test(tokenHex)) {
        throw new Error('The miio token must be exactly 32 hexadecimal characters');
    }
    const token = Buffer.from(tokenHex, 'hex');
    const key = (0, node_crypto_1.createHash)('md5').update(token).digest();
    const iv = (0, node_crypto_1.createHash)('md5').update(key).update(token).digest();
    return { token, key, iv };
}
/** Encode a Xiaomi miIO v2 UDP request packet. Exported for regression tests. */
function encodeMiioPacket(payload, deviceId, stamp, tokenHex) {
    const { token, key, iv } = deriveMiioKeyMaterial(tokenHex);
    const cipher = (0, node_crypto_1.createCipheriv)('aes-128-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    const header = Buffer.alloc(32);
    header.writeUInt16BE(0x2131, 0);
    header.writeUInt16BE(header.length + encrypted.length, 2);
    header.writeUInt32BE(0, 4);
    header.writeUInt32BE(deviceId >>> 0, 8);
    header.writeUInt32BE(stamp >>> 0, 12);
    const checksum = (0, node_crypto_1.createHash)('md5')
        .update(header.subarray(0, 16))
        .update(token)
        .update(encrypted)
        .digest();
    checksum.copy(header, 16);
    token.fill(0);
    key.fill(0);
    iv.fill(0);
    return Buffer.concat([header, encrypted]);
}
/** Validate and decrypt a Xiaomi miIO v2 UDP response packet. */
function decodeMiioPacket(packet, tokenHex) {
    if (packet.length < 32 || packet.readUInt16BE(0) !== 0x2131) {
        throw new Error('Invalid miio packet header');
    }
    const declaredLength = packet.readUInt16BE(2);
    if (declaredLength !== packet.length) {
        throw new Error(`Invalid miio packet length: ${declaredLength}`);
    }
    const encrypted = packet.subarray(32);
    if (!encrypted.length) {
        return Buffer.alloc(0);
    }
    const { token, key, iv } = deriveMiioKeyMaterial(tokenHex);
    const expectedChecksum = (0, node_crypto_1.createHash)('md5')
        .update(packet.subarray(0, 16))
        .update(token)
        .update(encrypted)
        .digest();
    const packetChecksum = packet.subarray(16, 32);
    if (!packetChecksum.equals(expectedChecksum)) {
        token.fill(0);
        key.fill(0);
        iv.fill(0);
        throw new Error('Invalid miio packet checksum');
    }
    try {
        const decipher = (0, node_crypto_1.createDecipheriv)('aes-128-cbc', key, iv);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]);
    }
    finally {
        token.fill(0);
        key.fill(0);
        iv.fill(0);
    }
}
function asError(value) {
    if (value instanceof Error) {
        return value;
    }
    const data = value;
    const error = new Error(data?.message ?? String(value));
    error.code = data?.code;
    return error;
}
/**
 * Minimal single-device miIO transport. It intentionally implements only the
 * encrypted LAN protocol used by the purifier, with no discovery or cloud code.
 */
class MiotProtocol {
    constructor(ip, tokenHex, log) {
        this.ip = ip;
        this.log = log;
        this.deviceId = null;
        this.serverStamp = 0;
        this.serverStampReceivedAt = 0;
        this.nextRequestId = 1;
        this.handshakePromise = null;
        this.handshakeResolve = null;
        this.handshakeReject = null;
        this.handshakeTimer = null;
        this.pending = new Map();
        this.destroyed = false;
        deriveMiioKeyMaterial(tokenHex);
        this.tokenHex = tokenHex;
        this.socket = (0, node_dgram_1.createSocket)('udp4');
        this.socket.on('message', (packet, remote) => this.handleMessage(packet, remote));
        this.socket.on('error', (error) => {
            this.log.debug(`[Purifier ${this.ip}] UDP socket error: ${error.message}`);
        });
    }
    async connect() {
        await this.ensureHandshake(true);
    }
    async info() {
        return this.call('miIO.info', []);
    }
    async call(method, params = [], options = {}) {
        const retries = options.retries ?? 2;
        const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
        let lastError;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
            try {
                await this.ensureHandshake();
                return await this.sendOnce(method, params, timeoutMs);
            }
            catch (value) {
                const error = asError(value);
                lastError = error;
                const recoverable = error.message.includes('timed out')
                    || RECOVERABLE_ERROR_CODES.has(error.code ?? 0);
                if (!recoverable || attempt >= retries) {
                    throw error;
                }
                this.invalidateHandshake();
                this.log.debug(`[Purifier ${this.ip}] ${method} failed; retrying locally (${attempt + 1}/${retries})`);
            }
        }
        throw lastError ?? new Error(`Local miio request ${method} failed`);
    }
    isReady() {
        return !this.destroyed && this.deviceId !== null;
    }
    getDeviceId() {
        return this.deviceId;
    }
    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        const error = new Error('miio transport closed');
        this.rejectHandshake(error);
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
        try {
            this.socket.close();
        }
        catch {
            // A never-bound UDP socket has nothing to close.
        }
    }
    async ensureHandshake(force = false) {
        if (this.destroyed) {
            throw new Error('miio transport is closed');
        }
        const age = Date.now() - this.serverStampReceivedAt;
        if (!force && this.deviceId !== null && age < HANDSHAKE_MAX_AGE_MS) {
            return;
        }
        if (this.handshakePromise) {
            return this.handshakePromise;
        }
        const handshake = new Promise((resolve, reject) => {
            this.handshakeResolve = resolve;
            this.handshakeReject = reject;
            this.handshakeTimer = setTimeout(() => {
                this.rejectHandshake(new Error(`LAN handshake with ${this.ip} timed out`));
            }, HANDSHAKE_TIMEOUT_MS);
        });
        this.handshakePromise = handshake;
        try {
            await this.sendPacket(exports.MIIO_HANDSHAKE_PACKET);
        }
        catch (value) {
            this.rejectHandshake(asError(value));
        }
        return handshake;
    }
    sendOnce(method, params, timeoutMs) {
        if (this.deviceId === null) {
            return Promise.reject(new Error('miio handshake has not completed'));
        }
        const id = this.allocateRequestId();
        const body = Buffer.from(JSON.stringify({ id, method, params }), 'utf8');
        const elapsedSeconds = Math.floor((Date.now() - this.serverStampReceivedAt) / 1000);
        const packet = encodeMiioPacket(body, this.deviceId, this.serverStamp + elapsedSeconds, this.tokenHex);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Local miio request ${method} timed out`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (value) => resolve(value),
                reject,
                timer,
            });
            this.sendPacket(packet).catch((value) => {
                const pending = this.pending.get(id);
                if (!pending)
                    return;
                this.pending.delete(id);
                clearTimeout(pending.timer);
                reject(asError(value));
            });
        });
    }
    handleMessage(packet, remote) {
        if (remote.address !== this.ip || packet.length < 32)
            return;
        try {
            if (packet.readUInt16BE(0) !== 0x2131)
                return;
            this.deviceId = packet.readUInt32BE(8);
            this.serverStamp = packet.readUInt32BE(12);
            this.serverStampReceivedAt = Date.now();
            if (packet.length === 32) {
                this.resolveHandshake();
                return;
            }
            const decoded = decodeMiioPacket(packet, this.tokenHex);
            const text = decoded
                .toString('utf8')
                .replace(/[\x00-\x09\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, '');
            const response = JSON.parse(text);
            if (typeof response.id !== 'number')
                return;
            const pending = this.pending.get(response.id);
            if (!pending)
                return;
            this.pending.delete(response.id);
            clearTimeout(pending.timer);
            if (response.error) {
                pending.reject(asError(response.error));
            }
            else if ('result' in response) {
                pending.resolve(response.result);
            }
            else {
                pending.reject(new Error('Malformed miio response'));
            }
        }
        catch (value) {
            this.log.debug(`[Purifier ${this.ip}] Ignoring invalid LAN packet: ${asError(value).message}`);
        }
    }
    sendPacket(packet) {
        return new Promise((resolve, reject) => {
            this.socket.send(packet, MIIO_PORT, this.ip, (error) => {
                if (error)
                    reject(error);
                else
                    resolve();
            });
        });
    }
    allocateRequestId() {
        const id = this.nextRequestId;
        this.nextRequestId = id >= 9999 ? 1 : id + 1;
        return id;
    }
    invalidateHandshake() {
        this.deviceId = null;
        this.serverStampReceivedAt = 0;
    }
    resolveHandshake() {
        if (this.handshakeTimer)
            clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        const resolve = this.handshakeResolve;
        this.handshakeResolve = null;
        this.handshakeReject = null;
        this.handshakePromise = null;
        resolve?.();
    }
    rejectHandshake(error) {
        if (this.handshakeTimer)
            clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        const reject = this.handshakeReject;
        this.handshakeResolve = null;
        this.handshakeReject = null;
        this.handshakePromise = null;
        reject?.(error);
    }
}
exports.MiotProtocol = MiotProtocol;
//# sourceMappingURL=miotProtocol.js.map