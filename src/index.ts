import type { API } from 'homebridge';
import { XiaomiAirPurifierLanPlatform } from './platform';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

export = (api: API) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, XiaomiAirPurifierLanPlatform);
};
