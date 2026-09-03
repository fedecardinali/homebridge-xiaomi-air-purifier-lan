import type { Logger } from 'homebridge';
import { type MiioInfo } from './miotProtocol';
export interface MiotTransport {
    connect(): Promise<void>;
    info(): Promise<MiioInfo>;
    call<T>(method: string, params?: unknown, options?: {
        retries?: number;
        timeoutMs?: number;
    }): Promise<T>;
    isReady(): boolean;
    getDeviceId(): number | null;
    destroy(): void;
}
export interface PurifierState {
    on: boolean;
    mode: number;
    favoriteLevel: number;
    motorRpm: number;
    pm25: number;
    filterLife: number;
}
export declare function favoriteLevelToPercent(level: number): number;
export declare function percentToFavoriteLevel(percent: number): number;
export declare function motorRpmToPercent(rpm: number): number;
export declare function currentSpeedPercent(state: PurifierState | null): number;
/** HomeKit AirQuality values: 1 excellent, 2 good, 3 fair, 4 inferior, 5 poor. */
export declare function airQualityForPm25(pm25: number): number;
export declare class PurifierClient {
    private readonly ip;
    private readonly log;
    private readonly protocol;
    private operationQueue;
    private lastState;
    private model;
    private firmware;
    constructor(ip: string, token: string, log: Logger, protocol?: MiotTransport);
    connect(): Promise<void>;
    isConnected(): boolean;
    getModel(): string;
    getFirmware(): string;
    getStableId(): string;
    getLastState(): PurifierState | null;
    getState(): Promise<PurifierState>;
    setActive(on: boolean, preferredManualLevel?: number): Promise<PurifierState>;
    setAutomatic(automatic: boolean, preferredManualLevel?: number): Promise<PurifierState>;
    setManualSpeed(percent: number): Promise<PurifierState>;
    destroy(): void;
    private writeProperties;
    private patchState;
    private ensureConnected;
    private validManualLevel;
    private enqueue;
}
//# sourceMappingURL=purifierClient.d.ts.map