'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  airQualityForPm25,
  currentSpeedPercent,
  favoriteLevelToPercent,
  motorRpmToPercent,
  percentToFavoriteLevel,
  PurifierClient,
} = require('../dist/purifierClient');
const {
  decodeMiioPacket,
  deriveMiioKeyMaterial,
  encodeMiioPacket,
} = require('../dist/miotProtocol');

const silentLog = {
  info() {},
  debug() {},
  warn() {},
  error() {},
};

function fakeTransport() {
  const calls = [];
  const values = new Map([
    ['2.1', true],
    ['2.4', 0],
    ['9.11', 7],
    ['9.1', 625],
    ['3.4', 12],
    ['4.1', 81],
  ]);
  return {
    calls,
    values,
    async connect() {},
    async info() {
      return { model: 'zhimi.airp.cpa4', fw_ver: '2.3.4' };
    },
    async call(method, params) {
      calls.push({ method, params: structuredClone(params) });
      if (method === 'get_properties') {
        return params.map(item => ({
          ...item,
          code: 0,
          value: values.get(`${item.siid}.${item.piid}`),
        }));
      }
      if (method === 'set_properties') {
        for (const item of params) values.set(`${item.siid}.${item.piid}`, item.value);
        return params.map(item => ({ ...item, code: 0 }));
      }
      throw new Error(`Unexpected method ${method}`);
    },
    isReady() { return true; },
    getDeviceId() { return 42; },
    destroy() {},
  };
}

test('miio packet codec round-trips and rejects tampering', () => {
  const token = '00112233445566778899aabbccddeeff';
  const body = Buffer.from(JSON.stringify({ id: 7, method: 'get_properties', params: [] }));
  const packet = encodeMiioPacket(body, 0x12345678, 1_700_000_000, token);

  assert.deepEqual(decodeMiioPacket(packet, token), body);
  const tampered = Buffer.from(packet);
  tampered[tampered.length - 1] ^= 0x01;
  assert.throws(() => decodeMiioPacket(tampered, token), /checksum/);
  assert.throws(() => deriveMiioKeyMaterial('bad-token'), /32 hexadecimal/);
});

test('state reads use two sequential firmware-safe batches of three properties', async () => {
  const transport = fakeTransport();
  const client = new PurifierClient(
    '192.0.2.20',
    '0'.repeat(32),
    silentLog,
    transport,
  );

  await client.connect();
  const state = await client.getState();
  const reads = transport.calls.filter(call => call.method === 'get_properties');

  assert.equal(reads.length, 2);
  assert.deepEqual(reads.map(call => call.params.length), [3, 3]);
  assert.deepEqual(state, {
    on: true,
    mode: 0,
    favoriteLevel: 7,
    motorRpm: 625,
    pm25: 12,
    filterLife: 81,
  });
});

test('manual speed is one atomic write that also powers on and selects Favorite', async () => {
  const transport = fakeTransport();
  const client = new PurifierClient(
    '192.0.2.20',
    '0'.repeat(32),
    silentLog,
    transport,
  );

  await client.connect();
  const state = await client.setManualSpeed(50);
  const writes = transport.calls.filter(call => call.method === 'set_properties');

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].params, [
    { did: 'homebridge-purifier', siid: 2, piid: 1, value: true },
    { did: 'homebridge-purifier', siid: 2, piid: 4, value: 2 },
    { did: 'homebridge-purifier', siid: 9, piid: 11, value: 7 },
  ]);
  assert.equal(state.on, true);
  assert.equal(state.mode, 2);
  assert.equal(state.favoriteLevel, 7);
});

test('selecting Manual replaces a stored zero level in the same atomic write', async () => {
  const transport = fakeTransport();
  transport.values.set('9.11', 0);
  const client = new PurifierClient(
    '192.0.2.20',
    '0'.repeat(32),
    silentLog,
    transport,
  );

  await client.connect();
  await client.getState();
  const state = await client.setAutomatic(false);
  const writes = transport.calls.filter(call => call.method === 'set_properties');

  assert.deepEqual(writes.at(-1).params, [
    { did: 'homebridge-purifier', siid: 2, piid: 1, value: true },
    { did: 'homebridge-purifier', siid: 2, piid: 4, value: 2 },
    { did: 'homebridge-purifier', siid: 9, piid: 11, value: 7 },
  ]);
  assert.equal(state.on, true);
  assert.equal(state.mode, 2);
  assert.equal(state.favoriteLevel, 7);
});

test('selecting Auto powers on and changes mode in one request', async () => {
  const transport = fakeTransport();
  const client = new PurifierClient(
    '192.0.2.20',
    '0'.repeat(32),
    silentLog,
    transport,
  );

  await client.connect();
  const state = await client.setAutomatic(true);
  const writes = transport.calls.filter(call => call.method === 'set_properties');

  assert.deepEqual(writes.at(-1).params, [
    { did: 'homebridge-purifier', siid: 2, piid: 1, value: true },
    { did: 'homebridge-purifier', siid: 2, piid: 4, value: 0 },
  ]);
  assert.equal(state.on, true);
  assert.equal(state.mode, 0);
});

test('speed and PM2.5 conversions stay inside HomeKit and device ranges', () => {
  assert.equal(percentToFavoriteLevel(0), 0);
  assert.equal(percentToFavoriteLevel(1), 1);
  assert.equal(percentToFavoriteLevel(50), 7);
  assert.equal(percentToFavoriteLevel(100), 14);
  assert.equal(favoriteLevelToPercent(7), 50);
  assert.equal(motorRpmToPercent(625), 25);
  assert.equal(currentSpeedPercent({
    on: true,
    mode: 0,
    favoriteLevel: 7,
    motorRpm: 625,
    pm25: 0,
    filterLife: 100,
  }), 25);
  assert.equal(currentSpeedPercent({
    on: true,
    mode: 2,
    favoriteLevel: 0,
    motorRpm: 500,
    pm25: 0,
    filterLife: 100,
  }), 20);
  assert.deepEqual([0, 8, 16, 31, 56].map(airQualityForPm25), [1, 2, 3, 4, 5]);
});
