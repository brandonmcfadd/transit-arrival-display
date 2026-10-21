const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

async function fetchBusArrivals(predictions, query = {}) {
  const routes = new Map();
  const errors = [];
  const app = {
    register() {},
    get(route, handler) { routes.set(route, handler); },
    listen() {},
  };
  const dependencies = {
    fastify: () => app,
    dotenv: { config() {} },
    handlebars: { registerHelper() {} },
    'nano-cache': {},
    'node-persist': {},
    '@fastify/formbody': () => {},
    '@fastify/static': () => {},
    '@fastify/view': () => {},
  };
  const context = vm.createContext({
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    __dirname: root,
    process: { env: {} },
    console: { error: (...args) => errors.push(args) },
    URL, AbortController, setTimeout, clearTimeout,
    fetch: async () => ({
      ok: true,
      json: async () => ({ 'bustime-response': { prd: predictions } }),
    }),
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), context);
  const reply = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    header() { return this; },
    send(body) { return JSON.parse(JSON.stringify(body)); },
  };
  const body = await routes.get('/api/cta-arrivals')({
    query: { busStpid: '123', ...query },
  }, reply);
  return { body, status: reply.statusCode, errors };
}

function prediction(prdtm, overrides = {}) {
  return {
    tmstmp: '20261021 14:39', prdtm, prdctdn: '99',
    rt: '22', stpnm: 'Clark & Lake', rtdir: 'Northbound', des: 'Howard',
    ...overrides,
  };
}

test('uses timestamps rather than countdowns and marks 0-2 minutes as arriving', async () => {
  const { body } = await fetchBusArrivals([
    prediction('20261021 15:00', { prdctdn: 'DUE' }),
    ...['14:42', '14:41', '14:40', '14:39'].map(time => prediction(`20261021 ${time}`)),
  ]);
  assert.deepEqual(body.arrivals.map(item => item.arrivalTime), [0, 1, 2, 3, 21]);
  assert.deepEqual(body.arrivals.map(item => item.isArriving), [true, true, true, false, false]);
});

test('handles date rollover, seconds, sorting, and walk-time filtering', async () => {
  const { body } = await fetchBusArrivals([
    prediction('20261101 00:10', { tmstmp: '20261031 23:49' }),
    prediction('20270101 00:03:59', { tmstmp: '20261231 23:59:00' }),
    prediction('20261021 14:41'),
    prediction('20261021 14:38'),
  ], { busWalkTime: '3' });
  assert.deepEqual(body.arrivals.map(item => item.arrivalTime), [4, 21]);
  assert.equal(body.filteredCounts.buses, 2);
});

test('delays preserve calculated minutes and obey walk-time filtering', async () => {
  const { body } = await fetchBusArrivals([
    prediction('20261021 15:00', { prdctdn: 'DLY' }),
    prediction('20261021 14:44', { dly: true }),
    prediction('20261021 14:45', { dly: false }),
    prediction('20261021 14:40', { dly: true }),
  ], { busWalkTime: '3' });
  assert.deepEqual(body.arrivals.map(item => [item.arrivalTime, item.isDelayed]),
    [[5, '1'], [6, '0'], [21, '1']]);
  assert.equal(body.filteredCounts.buses, 1);
});

test('holiday bus 4374 receives the holiday flag without changing its route or timing', async () => {
  const { body } = await fetchBusArrivals([
    prediction('20261021 14:44', { vid: '4374' }),
    prediction('20261021 14:45', { vid: 4374 }),
    prediction('20261021 14:46', { vid: '4375' }),
    prediction('20261021 14:47'),
  ]);
  assert.deepEqual(body.arrivals.map(item => item.isHoliday), [true, true, false, false]);
  assert.deepEqual(body.arrivals.map(item => item.arrivalTime), [5, 6, 7, 8]);
  assert.ok(body.arrivals.every(item => item.route === 'Bus' && item.routeNumber === '22'));
});

test('invalid or missing timestamps produce explicit source errors', async () => {
  for (const value of [undefined, 'invalid', '20260230 15:00', '20261021 24:00']) {
    const { body, status, errors } = await fetchBusArrivals([prediction(value)]);
    assert.equal(status, 502);
    assert.match(body.details[0], /Invalid bus prediction timestamp/);
    assert.equal(errors.length, 1);
  }
});

test('both pages show Due at 0-2 minutes for buses, preserving train and delay behavior', () => {
  const index = fs.readFileSync(path.join(root, 'src/pages/index.hbs'), 'utf8');
  const reduced = fs.readFileSync(path.join(root, 'src/pages/reduced-format.hbs'), 'utf8');
  const indexScript = index.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(indexScript);
  const timing = indexScript.slice(indexScript.indexOf('let timingDisplay;'), indexScript.indexOf('let trackingIcon'));
  const context = vm.createContext({ window: {} });
  vm.runInContext(reduced.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  for (const route of ['Bus', 'Red']) {
    for (const minutes of [0, 1, 2, 3, 21]) {
      for (const delayed of ['0', '1']) {
        const arrival = { route, arrivalTime: minutes, isDelayed: delayed };
        const expected = delayed === '1' ? 'Delayed'
          : minutes <= (route === 'Bus' ? 2 : 1) ? 'Due' : String(minutes);
        const display = vm.runInNewContext(`${timing}\ntimingDisplay`, { arrival });
        assert.ok(display.includes(`>${expected}</span>`));
        context.arrival = arrival;
        assert.equal(String(vm.runInContext('formatEta(arrival).value', context)), expected);
      }
    }
  }
});
