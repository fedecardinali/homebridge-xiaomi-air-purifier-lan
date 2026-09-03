export declare const PLUGIN_NAME = "homebridge-xiaomi-air-purifier-lan";
export declare const PLATFORM_NAME = "XiaomiAirPurifierLan";
export declare const PLUGIN_VERSION = "0.1.3";
export interface PurifierDeviceConfig {
    name: string;
    ip: string;
    token: string;
    pollInterval?: number;
}
export interface PurifierPlatformConfig {
    platform: typeof PLATFORM_NAME;
    name?: string;
    devices: PurifierDeviceConfig[];
}
//# sourceMappingURL=settings.d.ts.map