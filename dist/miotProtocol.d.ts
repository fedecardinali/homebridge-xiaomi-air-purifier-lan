import type { Logger } from 'homebridge';
export declare const MIIO_HANDSHAKE_PACKET: Buffer<ArrayBuffer>;
export interface MiioInfo {
    model?: string;
    fw_ver?: string;
    [key: string]: unknown;
}
interface KeyMaterial {
    token: Buffer;
    key: Buffer;
    iv: Buffer;
}
export declare function deriveMiioKeyMaterial(tokenHex: string): KeyMaterial;
/** Encode a Xiaomi miIO v2 UDP request packet. Exported for regression tests. */
export declare function encodeMiioPacket(payload: Buffer, deviceId: number, stamp: number, tokenHex: string): Buffer;
/** Validate and decrypt a Xiaomi miIO v2 UDP response packet. */
export declare function decodeMiioPacket(packet: Buffer, tokenHex: string): Buffer;
/**
 * Minimal single-device miIO transport. It intentionally implements only the
 * encrypted LAN protocol used by the purifier, with no discovery or cloud code.
 */
export declare class MiotProtocol {
    private readonly ip;
    private readonly log;
    private readonly socket;
    private readonly tokenHex;
    private deviceId;
    private serverStamp;
    private serverStampReceivedAt;
    private nextRequestId;
    private handshakePromise;
    private handshakeResolve;
    private handshakeReject;
    private handshakeTimer;
    private readonly pending;
    private destroyed;
    constructor(ip: string, tokenHex: string, log: Logger);
    connect(): Promise<void>;
    info(): Promise<MiioInfo>;
    call<T>(method: string, params?: unknown, options?: {
        retries?: number;
        timeoutMs?: number;
    }): Promise<T>;
    isReady(): boolean;
    getDeviceId(): number | null;
    destroy(): void;
    private ensureHandshake;
    private sendOnce;
    private handleMessage;
    private sendPacket;
    private allocateRequestId;
    private invalidateHandshake;
    private resolveHandshake;
    private rejectHandshake;
}
export {};
//# sourceMappingURL=miotProtocol.d.ts.map