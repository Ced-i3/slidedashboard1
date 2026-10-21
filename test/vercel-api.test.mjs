import assert from 'node:assert/strict';
import test from 'node:test';
import vercelFunction from '../api/v1/[...path].mjs';
import { getConfig } from '../api/slide-api.mjs';

test('Vercel API configuration no longer needs a dashboard password', async () => {
  const keys = ['DATABASE_URL', 'SLIDE_DEVICE_ID', 'SLIDE_DEVICE_TOKEN', 'SLIDE_DASHBOARD_PASSWORD'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    process.env.DATABASE_URL = 'postgresql://slide:test@localhost/slide';
    process.env.SLIDE_DEVICE_ID = 'SLIDE-TEST';
    process.env.SLIDE_DEVICE_TOKEN = 'test-device-token-'.padEnd(48, 'x');
    assert.deepEqual(getConfig(), {
      databaseUrl: process.env.DATABASE_URL,
      deviceId: process.env.SLIDE_DEVICE_ID,
      deviceToken: process.env.SLIDE_DEVICE_TOKEN,
    });

    for (const key of keys) delete process.env[key];
    const response = await vercelFunction.fetch(new Request('https://slide.akios.site/api/v1/session'));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'api_not_configured' });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
