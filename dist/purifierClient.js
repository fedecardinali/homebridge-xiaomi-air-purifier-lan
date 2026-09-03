"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PurifierClient = void 0;
exports.favoriteLevelToPercent = favoriteLevelToPercent;
exports.percentToFavoriteLevel = percentToFavoriteLevel;
exports.motorRpmToPercent = motorRpmToPercent;
exports.currentSpeedPercent = currentSpeedPercent;
exports.airQualityForPm25 = airQualityForPm25;
const miotProtocol_1 = require("./miotProtocol");
const EXPECTED_MODEL = 'zhimi.airp.cpa4';
const REQUEST_DID = 'homebridge-purifier';
const MAX_BATCH_SIZE = 3;
const STATE_PROPERTIES = [
    { key: 'on', siid: 2, piid: 1 },
    { key: 'mode', siid: 2, piid: 4 },
    { key: 'favoriteLevel', siid: 9, piid: 11 },
    { key: 'motorRpm', siid: 9, piid: 1 },
    { key: 'pm25', siid: 3, piid: 4 },
    { key: 'filterLife', siid: 4, piid: 1 },
];
function favoriteLevelToPercent(level) {
    return Math.max(0, Math.min(100, Math.round((level / 14) * 100)));
}
function percentToFavoriteLevel(percent) {
    if (percent <= 0)
        return 0;
    return Math.max(1, Math.min(14, Math.round((percent / 100) * 14)));
}
function motorRpmToPercent(rpm) {
    return Math.max(0, Math.min(100, Math.round((rpm / 2500) * 100)));
}
function currentSpeedPercent(state) {
    if (!state?.on)
        return 0;
    return state.mode === 2 && state.favoriteLevel > 0
        ? favoriteLevelToPercent(state.favoriteLevel)
        : motorRpmToPercent(state.motorRpm);
}
/** HomeKit AirQuality values: 1 excellent, 2 good, 3 fair, 4 inferior, 5 poor. */
function airQualityForPm25(pm25) {
    if (pm25 <= 7)
        return 1;
    if (pm25 <= 15)
        return 2;
    if (pm25 <= 30)
        return 3;
    if (pm25 <= 55)
        return 4;
    return 5;
}
function numberValue(value, label) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        throw new Error(`Purifier returned an invalid ${label}`);
    }
    return numeric;
}
class PurifierClient {
    constructor(ip, token, log, protocol) {
        this.ip = ip;
        this.log = log;
        this.operationQueue = Promise.resolve();
        this.lastState = null;
        this.model = EXPECTED_MODEL;
        this.firmware = 'unknown';
        this.protocol = protocol ?? new miotProtocol_1.MiotProtocol(ip, token, log);
    }
    async connect() {
        await this.enqueue(async () => {
            await this.ensureConnected();
            const info = await this.protocol.info();
            this.model = typeof info.model === 'string' ? info.model : EXPECTED_MODEL;
            this.firmware = typeof info.fw_ver === 'string' ? info.fw_ver : 'unknown';
            if (this.model !== EXPECTED_MODEL) {
                throw new Error(`Unsupported model ${this.model}; expected ${EXPECTED_MODEL}`);
            }
        });
        this.log.info(`[Purifier ${this.ip}] Connected over the local LAN (${this.model})`);
    }
    isConnected() {
        return this.protocol.isReady();
    }
    getModel() {
        return this.model;
    }
    getFirmware() {
        return this.firmware;
    }
    getStableId() {
        const deviceId = this.protocol.getDeviceId();
        return deviceId === null ? this.ip.replace(/\./g, '-') : String(deviceId);
    }
    getLastState() {
        return this.lastState ? { ...this.lastState } : null;
    }
    async getState() {
        return this.enqueue(async () => {
            await this.ensureConnected();
            const results = [];
            // The cpa4 firmware accepts at most three properties per request. Send
            // batches sequentially; parallel chunks are what made the generic plugin
            // intermittently return "busy" and stale state.
            for (let offset = 0; offset < STATE_PROPERTIES.length; offset += MAX_BATCH_SIZE) {
                const refs = STATE_PROPERTIES.slice(offset, offset + MAX_BATCH_SIZE);
                const params = refs.map(({ siid, piid }) => ({
                    did: REQUEST_DID,
                    siid,
                    piid,
                }));
                const batch = await this.protocol.call('get_properties', params, { retries: 1, timeoutMs: 3500 });
                if (!Array.isArray(batch)) {
                    throw new Error('Purifier returned an invalid property response');
                }
                results.push(...batch);
            }
            const read = (ref) => {
                const result = results.find(item => item.siid === ref.siid && item.piid === ref.piid);
                if (!result || result.code !== 0 || result.value === undefined) {
                    return this.lastState?.[ref.key];
                }
                return result.value;
            };
            const values = Object.fromEntries(STATE_PROPERTIES.map(ref => [ref.key, read(ref)]));
            if (values.on === undefined || values.mode === undefined) {
                throw new Error('Purifier has no valid power or mode state yet');
            }
            const state = {
                on: Boolean(values.on),
                mode: Math.max(0, Math.min(2, numberValue(values.mode, 'mode'))),
                favoriteLevel: Math.max(0, Math.min(14, numberValue(values.favoriteLevel ?? 0, 'favorite level'))),
                motorRpm: Math.max(0, numberValue(values.motorRpm ?? 0, 'motor speed')),
                pm25: Math.max(0, numberValue(values.pm25 ?? 0, 'PM2.5')),
                filterLife: Math.max(0, Math.min(100, numberValue(values.filterLife ?? 0, 'filter life'))),
            };
            this.lastState = state;
            return { ...state };
        });
    }
    async setActive(on, preferredManualLevel = 7) {
        const manualLevel = this.validManualLevel(preferredManualLevel);
        if (on && this.lastState?.mode === 2 && this.lastState.favoriteLevel <= 0) {
            await this.writeProperties([
                { siid: 2, piid: 1, value: true },
                { siid: 2, piid: 4, value: 2 },
                { siid: 9, piid: 11, value: manualLevel },
            ]);
            return this.patchState({ on: true, mode: 2, favoriteLevel: manualLevel });
        }
        await this.writeProperties([{ siid: 2, piid: 1, value: on }]);
        return this.patchState({ on });
    }
    async setAutomatic(automatic, preferredManualLevel = 7) {
        if (automatic) {
            // Home presents Auto, Manual, and Off in one picker. Selecting Auto must
            // therefore make the unit active as well as change its mode.
            await this.writeProperties([
                { siid: 2, piid: 1, value: true },
                { siid: 2, piid: 4, value: 0 },
            ]);
            return this.patchState({ on: true, mode: 0 });
        }
        // The purifier accepts favorite-level 0, but Home then renders Manual as
        // effectively off. Apply power, mode, and a valid remembered/default level
        // atomically so there is no intermediate off state.
        const favoriteLevel = this.validManualLevel(this.lastState?.favoriteLevel || preferredManualLevel);
        await this.writeProperties([
            { siid: 2, piid: 1, value: true },
            { siid: 2, piid: 4, value: 2 },
            { siid: 9, piid: 11, value: favoriteLevel },
        ]);
        return this.patchState({ on: true, mode: 2, favoriteLevel });
    }
    async setManualSpeed(percent) {
        const normalized = Math.max(0, Math.min(100, Number(percent)));
        if (normalized <= 0) {
            await this.writeProperties([{ siid: 2, piid: 1, value: false }]);
            return this.patchState({ on: false });
        }
        const favoriteLevel = percentToFavoriteLevel(normalized);
        // One atomic LAN request avoids the old race between switching to Favorite
        // mode and changing Favorite level. It also powers the unit on when the
        // user raises the HomeKit slider from zero.
        await this.writeProperties([
            { siid: 2, piid: 1, value: true },
            { siid: 2, piid: 4, value: 2 },
            { siid: 9, piid: 11, value: favoriteLevel },
        ]);
        return this.patchState({ on: true, mode: 2, favoriteLevel });
    }
    destroy() {
        this.protocol.destroy();
    }
    async writeProperties(properties) {
        await this.enqueue(async () => {
            await this.ensureConnected();
            const result = await this.protocol.call('set_properties', properties.map(property => ({ did: REQUEST_DID, ...property })), { retries: 2, timeoutMs: 3500 });
            if (!Array.isArray(result) || result.length !== properties.length) {
                throw new Error('Purifier returned an incomplete write response');
            }
            const failed = result.find(item => item.code !== 0);
            if (failed) {
                throw new Error(`Purifier rejected a property write (code ${failed.code})`);
            }
        });
    }
    patchState(patch) {
        const fallback = {
            on: false,
            mode: 0,
            favoriteLevel: 7,
            motorRpm: 0,
            pm25: 0,
            filterLife: 0,
        };
        this.lastState = { ...(this.lastState ?? fallback), ...patch };
        return { ...this.lastState };
    }
    async ensureConnected() {
        if (!this.protocol.isReady()) {
            await this.protocol.connect();
        }
    }
    validManualLevel(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0)
            return 7;
        return Math.max(1, Math.min(14, Math.round(numeric)));
    }
    enqueue(operation) {
        const queued = this.operationQueue.then(operation, operation);
        this.operationQueue = queued.then(() => undefined, () => undefined);
        return queued;
    }
}
exports.PurifierClient = PurifierClient;
//# sourceMappingURL=purifierClient.js.map