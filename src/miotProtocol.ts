import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { createSocket, RemoteInfo, Socket } from 'node:dgram';
import type { Logger } from 'homebridge';

const MIIO_PORT = 54321;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 4_000;
const HANDSHAKE_MAX_AGE_MS = 120_000;
const RECOVERABLE_ERROR_CODES = new Set([-30001, -9999]);

export const MIIO_HANDSHAKE_PACKET = Buffer.from(
  '21310020ffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'hex',
);

export interface MiioInfo {
  model?: string;
  fw_ver?: string;
  [key: string]: unknown;
}

interface MiioResponse<T> {
  id?: number;
  result?: T;
  error?: {
    code?: number;
    message?: string;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface KeyMaterial {
  token: Buffer;
  key: Buffer;
  iv: Buffer;
}

export function deriveMiioKeyMaterial(tokenHex: string): KeyMaterial {
  if (!/^[0-9a-fA-F]{32}$/.test(tokenHex)) {
    throw new Error('The miio token must be exactly 32 hexadecimal characters');
  }

  const token = Buffer.from(tokenHex, 'hex');
  const key = createHash('md5').update(token).digest();
  const iv = createHash('md5').update(key).update(token).digest();
  return { token, key, iv };
}

/** Encode a Xiaomi miIO v2 UDP request packet. Exported for regression tests. */
export function encodeMiioPacket(
  payload: Buffer,
  deviceId: number,
  stamp: number,
  tokenHex: string,
): Buffer {
  const { token, key, iv } = deriveMiioKeyMaterial(tokenHex);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const header = Buffer.alloc(32);

  header.writeUInt16BE(0x2131, 0);
  header.writeUInt16BE(header.length + encrypted.length, 2);
  header.writeUInt32BE(0, 4);
  header.writeUInt32BE(deviceId >>> 0, 8);
  header.writeUInt32BE(stamp >>> 0, 12);

  const checksum = createHash('md5')
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
export function decodeMiioPacket(packet: Buffer, tokenHex: string): Buffer {
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
  const expectedChecksum = createHash('md5')
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
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } finally {
    token.fill(0);
    key.fill(0);
    iv.fill(0);
  }
}

function asError(value: unknown): Error & { code?: number } {
  if (value instanceof Error) {
    return value;
  }

  const data = value as { code?: number; message?: string } | undefined;
  const error = new Error(data?.message ?? String(value)) as Error & {
    code?: number;
  };
  error.code = data?.code;
  return error;
}

/**
 * Minimal single-device miIO transport. It intentionally implements only the
 * encrypted LAN protocol used by the purifier, with no discovery or cloud code.
 */
export class MiotProtocol {
  private readonly socket: Socket;
  private readonly tokenHex: string;
  private deviceId: number | null = null;
  private serverStamp = 0;
  private serverStampReceivedAt = 0;
  private nextRequestId = 1;
  private handshakePromise: Promise<void> | null = null;
  private handshakeResolve: (() => void) | null = null;
  private handshakeReject: ((reason: Error) => void) | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private destroyed = false;

  constructor(
    private readonly ip: string,
    tokenHex: string,
    private readonly log: Logger,
  ) {
    deriveMiioKeyMaterial(tokenHex);
    this.tokenHex = tokenHex;
    this.socket = createSocket('udp4');
    this.socket.on('message', (packet, remote) => this.handleMessage(packet, remote));
    this.socket.on('error', (error) => {
      this.log.debug(`[Purifier ${this.ip}] UDP socket error: ${error.message}`);
    });
  }

  async connect(): Promise<void> {
    await this.ensureHandshake(true);
  }

  async info(): Promise<MiioInfo> {
    return this.call<MiioInfo>('miIO.info', []);
  }

  async call<T>(
    method: string,
    params: unknown = [],
    options: { retries?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    const retries = options.retries ?? 2;
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        await this.ensureHandshake();
        return await this.sendOnce<T>(method, params, timeoutMs);
      } catch (value) {
        const error = asError(value);
        lastError = error;
        const recoverable = error.message.includes('timed out')
          || RECOVERABLE_ERROR_CODES.has(error.code ?? 0);
        if (!recoverable || attempt >= retries) {
          throw error;
        }

        this.invalidateHandshake();
        this.log.debug(
          `[Purifier ${this.ip}] ${method} failed; retrying locally (${attempt + 1}/${retries})`,
        );
      }
    }

    throw lastError ?? new Error(`Local miio request ${method} failed`);
  }

  isReady(): boolean {
    return !this.destroyed && this.deviceId !== null;
  }

  getDeviceId(): number | null {
    return this.deviceId;
  }

  destroy(): void {
    if (this.destroyed) return;
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
    } catch {
      // A never-bound UDP socket has nothing to close.
    }
  }

  private async ensureHandshake(force = false): Promise<void> {
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

    const handshake = new Promise<void>((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
      this.handshakeTimer = setTimeout(() => {
        this.rejectHandshake(new Error(`LAN handshake with ${this.ip} timed out`));
      }, HANDSHAKE_TIMEOUT_MS);
    });
    this.handshakePromise = handshake;

    try {
      await this.sendPacket(MIIO_HANDSHAKE_PACKET);
    } catch (value) {
      this.rejectHandshake(asError(value));
    }

    return handshake;
  }

  private sendOnce<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.deviceId === null) {
      return Promise.reject(new Error('miio handshake has not completed'));
    }

    const id = this.allocateRequestId();
    const body = Buffer.from(JSON.stringify({ id, method, params }), 'utf8');
    const elapsedSeconds = Math.floor(
      (Date.now() - this.serverStampReceivedAt) / 1_000,
    );
    const packet = encodeMiioPacket(
      body,
      this.deviceId,
      this.serverStamp + elapsedSeconds,
      this.tokenHex,
    );

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Local miio request ${method} timed out`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      this.sendPacket(packet).catch((value) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(asError(value));
      });
    });
  }

  private handleMessage(packet: Buffer, remote: RemoteInfo): void {
    if (remote.address !== this.ip || packet.length < 32) return;

    try {
      if (packet.readUInt16BE(0) !== 0x2131) return;
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
      const response = JSON.parse(text) as MiioResponse<unknown>;
      if (typeof response.id !== 'number') return;

      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);

      if (response.error) {
        pending.reject(asError(response.error));
      } else if ('result' in response) {
        pending.resolve(response.result);
      } else {
        pending.reject(new Error('Malformed miio response'));
      }
    } catch (value) {
      this.log.debug(`[Purifier ${this.ip}] Ignoring invalid LAN packet: ${asError(value).message}`);
    }
  }

  private sendPacket(packet: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.send(packet, MIIO_PORT, this.ip, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private allocateRequestId(): number {
    const id = this.nextRequestId;
    this.nextRequestId = id >= 9_999 ? 1 : id + 1;
    return id;
  }

  private invalidateHandshake(): void {
    this.deviceId = null;
    this.serverStampReceivedAt = 0;
  }

  private resolveHandshake(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    const resolve = this.handshakeResolve;
    this.handshakeResolve = null;
    this.handshakeReject = null;
    this.handshakePromise = null;
    resolve?.();
  }

  private rejectHandshake(error: Error): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    const reject = this.handshakeReject;
    this.handshakeResolve = null;
    this.handshakeReject = null;
    this.handshakePromise = null;
    reject?.(error);
  }
}
