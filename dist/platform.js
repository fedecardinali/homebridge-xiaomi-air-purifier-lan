"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.XiaomiAirPurifierLanPlatform = void 0;
const purifierClient_1 = require("./purifierClient");
const settings_1 = require("./settings");
class XiaomiAirPurifierLanPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.cachedAccessories = new Map();
        this.activePurifiers = new Map();
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        this.api.on('didFinishLaunching', () => {
            this.start().catch(error => this.log.error(`Startup failed: ${error}`));
        });
        this.api.on('shutdown', () => this.shutdown());
    }
    configureAccessory(accessory) {
        this.cachedAccessories.set(accessory.UUID, accessory);
    }
    async start() {
        const platformConfig = this.config;
        const devices = platformConfig.devices ?? [];
        if (!devices.length) {
            this.log.warn('No Xiaomi Air Purifier 4 Compact devices are configured.');
        }
        for (const device of devices) {
            await this.startDevice(device);
        }
        const stale = [...this.cachedAccessories.values()];
        if (stale.length) {
            this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, stale);
            this.log.info(`Removed ${stale.length} stale purifier accessory record(s).`);
        }
    }
    async startDevice(config) {
        const { name, ip, token } = config;
        const pollInterval = Math.max(3000, config.pollInterval ?? 5000);
        if (!name || !ip || !/^[0-9a-fA-F]{32}$/.test(token ?? '')) {
            this.log.error('Skipping purifier with an invalid name, IP address, or token.');
            return;
        }
        if (this.activePurifiers.has(ip)) {
            this.log.warn(`Skipping duplicate purifier configuration for ${ip}.`);
            return;
        }
        const client = new purifierClient_1.PurifierClient(ip, token, this.log);
        try {
            await client.connect();
        }
        catch (error) {
            this.log.warn(`Initial LAN connection to "${name}" failed: ${error}`);
        }
        const uuid = this.api.hap.uuid.generate(`${settings_1.PLUGIN_NAME}:${ip}`);
        let accessory = this.cachedAccessories.get(uuid);
        const isNew = !accessory;
        if (!accessory) {
            accessory = new this.api.platformAccessory(name, uuid, 19 /* this.api.hap.Categories.AIR_PURIFIER */);
        }
        else {
            this.cachedAccessories.delete(uuid);
        }
        accessory.context.ip = ip;
        accessory.context.model = client.getModel();
        accessory.getService(this.Service.AccessoryInformation)
            .setCharacteristic(this.Characteristic.Manufacturer, 'Xiaomi')
            .setCharacteristic(this.Characteristic.Model, client.getModel())
            .setCharacteristic(this.Characteristic.SerialNumber, client.getStableId())
            .setCharacteristic(this.Characteristic.FirmwareRevision, client.getFirmware());
        const service = accessory.getService(this.Service.AirPurifier)
            ?? accessory.addService(this.Service.AirPurifier, name, 'purifier');
        service.setCharacteristic(this.Characteristic.Name, name);
        service.setCharacteristic(this.Characteristic.ConfiguredName, name);
        const airQualityService = accessory.getService(this.Service.AirQualitySensor)
            ?? accessory.addService(this.Service.AirQualitySensor, `${name} Air Quality`, 'air-quality');
        airQualityService.setCharacteristic(this.Characteristic.ConfiguredName, `${name} Air Quality`);
        service.addLinkedService(airQualityService);
        // This plugin intentionally exposes no Switch services. Remove any stale
        // non-native services if an older build was cached.
        const allowed = new Set([service, airQualityService, accessory.getService(this.Service.AccessoryInformation)]);
        for (const candidate of [...accessory.services]) {
            if (!allowed.has(candidate))
                accessory.removeService(candidate);
        }
        const active = {
            accessory,
            client,
            service,
            airQualityService,
            state: null,
            mutationEpoch: 0,
            lastManualLevel: 7,
            suppressSpeedUntil: 0,
            speedWaiters: [],
        };
        this.activePurifiers.set(ip, active);
        this.bindHandlers(active);
        if (isNew) {
            this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
        }
        else {
            this.api.updatePlatformAccessories([accessory]);
        }
        try {
            await this.refresh(active);
            this.log.info(`"${name}" is online through the LAN-only purifier plugin.`);
        }
        catch (error) {
            this.log.warn(`Could not read initial state for "${name}": ${error}`);
        }
        this.schedulePoll(active, pollInterval, pollInterval);
    }
    bindHandlers(active) {
        const { service } = active;
        service.getCharacteristic(this.Characteristic.Active)
            .onGet(() => active.state?.on
            ? this.Characteristic.Active.ACTIVE
            : this.Characteristic.Active.INACTIVE)
            .onSet(async (value) => {
            const on = Number(value) === this.Characteristic.Active.ACTIVE;
            const needsManualLevel = on
                && active.state?.mode === 2
                && (active.state?.favoriteLevel ?? 0) <= 0;
            await this.mutate(active, {
                on,
                ...(needsManualLevel ? { favoriteLevel: active.lastManualLevel } : {}),
            }, () => active.client.setActive(on, active.lastManualLevel));
        });
        service.getCharacteristic(this.Characteristic.CurrentAirPurifierState)
            .onGet(() => this.currentState(active.state));
        service.getCharacteristic(this.Characteristic.TargetAirPurifierState)
            .onGet(() => this.targetState(active.state))
            .onSet(async (value) => {
            const automatic = Number(value)
                === this.Characteristic.TargetAirPurifierState.AUTO;
            // Apple's combined Auto/Manual/Off picker follows its target-state
            // write with the slider's previously displayed RotationSpeed. Without
            // this short guard that companion event can immediately undo the mode
            // selection. A real slider gesture that starts before the target event
            // remains queued and keeps its selected value.
            active.suppressSpeedUntil = Date.now() + 1500;
            await this.mutate(active, automatic
                ? { on: true, mode: 0 }
                : {
                    on: true,
                    mode: 2,
                    favoriteLevel: active.lastManualLevel,
                }, () => active.client.setAutomatic(automatic, active.lastManualLevel));
        });
        service.getCharacteristic(this.Characteristic.RotationSpeed)
            .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
            .onGet(() => (0, purifierClient_1.currentSpeedPercent)(active.state))
            .onSet(value => this.scheduleSpeedWrite(active, Number(value)));
        service.getCharacteristic(this.Characteristic.FilterLifeLevel)
            .onGet(() => active.state?.filterLife ?? 0);
        service.getCharacteristic(this.Characteristic.FilterChangeIndication)
            .onGet(() => (active.state?.filterLife ?? 0) <= 5
            ? this.Characteristic.FilterChangeIndication.CHANGE_FILTER
            : this.Characteristic.FilterChangeIndication.FILTER_OK);
        active.airQualityService.getCharacteristic(this.Characteristic.AirQuality)
            .onGet(() => (0, purifierClient_1.airQualityForPm25)(active.state?.pm25 ?? 0));
        active.airQualityService.getCharacteristic(this.Characteristic.PM2_5Density)
            .onGet(() => active.state?.pm25 ?? 0);
    }
    async mutate(active, optimisticPatch, operation) {
        active.mutationEpoch += 1;
        if (active.state) {
            active.state = { ...active.state, ...optimisticPatch };
            this.updateHomeKit(active);
        }
        try {
            active.state = await operation();
            this.updateHomeKit(active);
        }
        catch (value) {
            const error = value instanceof Error ? value : new Error(String(value));
            this.log.warn(`Purifier command failed: ${error.message}`);
            try {
                await this.refresh(active);
            }
            catch {
                // The original HAP error is more useful than a failed recovery read.
            }
            throw new this.api.hap.HapStatusError(-70402 /* this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
        }
    }
    scheduleSpeedWrite(active, value) {
        const percent = Math.max(0, Math.min(100, value));
        if (Date.now() < active.suppressSpeedUntil) {
            this.log.debug('Ignored Home companion speed write during a mode change.');
            this.updateHomeKit(active);
            return Promise.resolve();
        }
        // The Home app emits a synthetic RotationSpeed=0 write when changing the
        // combined Auto/Manual/Off picker to Manual. Power is represented by the
        // separate Active characteristic, so never let that companion write undo
        // a still-active mode change. An actual Off selection also writes Active=0.
        if (percent <= 0 && active.state?.on) {
            this.log.debug('Ignored zero speed while the purifier remained Active.');
            this.updateHomeKit(active);
            return Promise.resolve();
        }
        active.pendingSpeed = percent;
        active.mutationEpoch += 1;
        if (active.state) {
            active.state = {
                ...active.state,
                on: percent > 0,
                ...(percent > 0
                    ? { mode: 2, favoriteLevel: Math.max(1, Math.round(percent * 14 / 100)) }
                    : {}),
            };
            this.updateHomeKit(active);
        }
        if (percent > 0) {
            active.lastManualLevel = Math.max(1, Math.round(percent * 14 / 100));
        }
        if (active.speedTimer)
            clearTimeout(active.speedTimer);
        const promise = new Promise((resolve, reject) => {
            active.speedWaiters.push({ resolve, reject });
        });
        active.speedTimer = setTimeout(() => {
            active.speedTimer = undefined;
            const target = active.pendingSpeed ?? 0;
            active.pendingSpeed = undefined;
            const waiters = active.speedWaiters.splice(0);
            active.client.setManualSpeed(target)
                .then(state => {
                active.state = state;
                this.updateHomeKit(active);
                waiters.forEach(waiter => waiter.resolve());
            })
                .catch(value => {
                const error = value instanceof Error ? value : new Error(String(value));
                this.log.warn(`Purifier speed command failed: ${error.message}`);
                waiters.forEach(waiter => waiter.reject(new this.api.hap.HapStatusError(-70402 /* this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE */)));
            });
        }, 180);
        return promise;
    }
    async refresh(active) {
        const epoch = active.mutationEpoch;
        const state = await active.client.getState();
        if (epoch !== active.mutationEpoch) {
            this.log.debug('Ignored a stale purifier poll completed during a HomeKit write.');
            return;
        }
        active.state = state;
        if (state.favoriteLevel > 0)
            active.lastManualLevel = state.favoriteLevel;
        this.updateHomeKit(active);
    }
    schedulePoll(active, pollInterval, delay) {
        if (active.pollTimer)
            clearTimeout(active.pollTimer);
        active.pollTimer = setTimeout(async () => {
            active.pollTimer = undefined;
            let nextDelay = pollInterval;
            try {
                await this.refresh(active);
            }
            catch (error) {
                nextDelay = Math.min(30000, pollInterval * 2);
                this.log.warn(`LAN state refresh failed; retrying in ${nextDelay} ms: ${error}`);
            }
            if (this.activePurifiers.has(active.accessory.context.ip)) {
                this.schedulePoll(active, pollInterval, nextDelay);
            }
        }, delay);
    }
    updateHomeKit(active) {
        const state = active.state;
        if (!state)
            return;
        active.service.updateCharacteristic(this.Characteristic.Active, state.on ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE);
        active.service.updateCharacteristic(this.Characteristic.CurrentAirPurifierState, this.currentState(state));
        active.service.updateCharacteristic(this.Characteristic.TargetAirPurifierState, this.targetState(state));
        active.service.updateCharacteristic(this.Characteristic.RotationSpeed, (0, purifierClient_1.currentSpeedPercent)(state));
        active.service.updateCharacteristic(this.Characteristic.FilterLifeLevel, state.filterLife);
        active.service.updateCharacteristic(this.Characteristic.FilterChangeIndication, state.filterLife <= 5
            ? this.Characteristic.FilterChangeIndication.CHANGE_FILTER
            : this.Characteristic.FilterChangeIndication.FILTER_OK);
        active.airQualityService.updateCharacteristic(this.Characteristic.AirQuality, (0, purifierClient_1.airQualityForPm25)(state.pm25));
        active.airQualityService.updateCharacteristic(this.Characteristic.PM2_5Density, state.pm25);
    }
    currentState(state) {
        if (!state?.on)
            return this.Characteristic.CurrentAirPurifierState.INACTIVE;
        return this.Characteristic.CurrentAirPurifierState.PURIFYING_AIR;
    }
    targetState(state) {
        return state?.mode === 0 || state?.mode === 1
            ? this.Characteristic.TargetAirPurifierState.AUTO
            : this.Characteristic.TargetAirPurifierState.MANUAL;
    }
    shutdown() {
        for (const active of this.activePurifiers.values()) {
            if (active.pollTimer)
                clearTimeout(active.pollTimer);
            if (active.speedTimer)
                clearTimeout(active.speedTimer);
            active.client.destroy();
        }
        this.activePurifiers.clear();
    }
}
exports.XiaomiAirPurifierLanPlatform = XiaomiAirPurifierLanPlatform;
//# sourceMappingURL=platform.js.map