import assert from 'node:assert/strict';
import test from 'node:test';
import vercelFunction from '../api/v1/[...path].mjs';

test('Vercel API fails closed with a JSON response until server settings are configured', async () => {
  const keys = ['DATABASE_URL', 'SLIDE_DEVICE_ID', 'SLIDE_DEVICE_TOKEN', 'SLIDE_DASHBOARD_PASSWORD'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
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
