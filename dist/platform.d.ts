import type { API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
export declare class XiaomiAirPurifierLanPlatform implements DynamicPlatformPlugin {
    readonly log: Logger;
    readonly config: PlatformConfig;
    readonly api: API;
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    private readonly cachedAccessories;
    private readonly activePurifiers;
    constructor(log: Logger, config: PlatformConfig, api: API);
    configureAccessory(accessory: PlatformAccessory): void;
    private start;
    private startDevice;
    private bindHandlers;
    private mutate;
    private scheduleSpeedWrite;
    private refresh;
    private schedulePoll;
    private updateHomeKit;
    private currentState;
    private targetState;
    private shutdown;
}
//# sourceMappingURL=platform.d.ts.map