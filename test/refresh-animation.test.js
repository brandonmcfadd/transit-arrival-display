const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

for (const page of ['index', 'reduced-format']) {
  test(`${page}: refresh reconciles rows after fetching, preserves old data on failure`, async () => {
    const animations = [];
    const errors = [];
    let completeFetch;
    const container = {
      childElementCount: 1,
      innerHTML: 'old arrivals',
      style: {},
    };
    const filterInfo = {};
    const warning = {};
    const loading = { style: {} };
    const context = vm.createContext({
      window: {
        location: { search: '?busStpid=123', origin: 'http://localhost' },
        innerHeight: 800,
        matchMedia: () => ({ matches: false }),
      },
      document: {
        getElementById: id => ({
          arrivalContainer: container, filterInfo, filterMessage: filterInfo, sourceWarning: warning,
        })[id],
        querySelector: () => loading,
      },
      URL, URLSearchParams,
      markArrivalsRefreshed() {},
      updateArrivalRows: async (target, rows, duration) => {
        animations.push({ rows, duration });
        target.innerHTML = '';
      },
      console: { error: (...args) => errors.push(args) },
      fetch: () => new Promise(resolve => { completeFetch = resolve; }),
    });
    const html = fs.readFileSync(path.join(__dirname, `../src/pages/${page}.hbs`), 'utf8');
    vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
    const refresh = vm.runInContext('fetchArrivals()', context);
    assert.equal(container.innerHTML, 'old arrivals');
    assert.equal(animations.length, 0);
    await vm.runInContext('fetchArrivals()', context);
    completeFetch({
      ok: true,
      headers: { get: () => null },
      json: async () => ({ arrivals: [], filteredCounts: { trains: 0, buses: 0 } }),
    });
    await refresh;
    assert.equal(container.innerHTML, '');
    assert.equal(animations.length, 1);
    assert.equal(animations[0].rows.length, 0);
    assert.equal(animations[0].duration, 300);
    container.innerHTML = 'last successful arrivals';
    context.fetch = async () => { throw new Error('Network unavailable'); };
    await vm.runInContext('fetchArrivals()', context);
    assert.equal(container.innerHTML, 'last successful arrivals');
    assert.equal(animations.length, 1);
    assert.equal(warning.hidden, false);
    assert.equal(errors.length, 1);
    assert.equal(vm.runInContext('refreshInProgress', context), false);
  });
}

test('keyed rows retain identity, update text, animate only structural changes', async () => {
  const context = vm.createContext({ Node: { TEXT_NODE: 3 } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/arrival-transitions.js'), 'utf8'), context);
  const animations = [];
  const container = {
    children: [],
    insertBefore(row, reference) {
      this.children = this.children.filter(child => child !== row);
      const index = reference ? this.children.indexOf(reference) : this.children.length;
      this.children.splice(index, 0, row);
    },
  };
  function row(key, text) {
    const textNode = {
      nodeType: 3, nodeName: '#text', nodeValue: text,
      isEqualNode(next) { return this.nodeValue === next.nodeValue; },
    };
    return {
      dataset: { key }, nodeType: 1, nodeName: 'DIV',
      childNodes: [textNode],
      get innerHTML() { return textNode.nodeValue; },
      isEqualNode(next) { return this.innerHTML === next.innerHTML; },
      attributes: [{ name: 'data-key', value: key }],
      hasAttribute() { return true; },
      getAttribute() { return key; },
      removeAttribute() {},
      setAttribute() {},
      getBoundingClientRect() {
        return { top: container.children.indexOf(this) * 96, height: 96 };
      },
      remove() { container.children = container.children.filter(item => item !== this); },
      animate(frames) {
        animations.push({ row: this, frames });
        return { finished: Promise.resolve() };
      },
    };
  }
  const a = row('a', '9 min');
  const originalTextNode = a.childNodes[0];
  const b = row('b', '12 min');
  container.children = [a, b];
  context.container = container;
  context.nextRows = [row('a', '8 min'), row('b', '11 min')];
  await vm.runInContext('updateArrivalRows(container, nextRows, 200)', context);
  assert.equal(container.children[0], a);
  assert.equal(a.innerHTML, '8 min');
  assert.equal(a.childNodes[0], originalTextNode);
  assert.equal(animations.length, 0);
  const c = row('c', '20 min');
  context.nextRows = [row('b', '10 min'), c];
  await vm.runInContext('updateArrivalRows(container, nextRows, 200)', context);
  assert.equal(container.children[0], b);
  assert.equal(container.children[1], c);
  assert.equal(animations[0].row, a);
  assert.equal(animations[0].frames[1].transform, 'translateY(-100%)');
  assert.equal(animations[1].row, c);
  animations.length = 0;
  context.nextRows = [row('c', '19 min'), row('b', '9 min')];
  await vm.runInContext('updateArrivalRows(container, nextRows, 200)', context);
  assert.equal(container.children[0], c);
  assert.equal(animations.length, 2);
  animations.length = 0;
  context.nextRows = [row('b', '8 min'), row('c', '18 min')];
  await vm.runInContext('updateArrivalRows(container, nextRows, 0)', context);
  assert.equal(animations.length, 0);
});

for (const duration of [200, 0]) {
  test(`removals, sorting, and additions run in sequence (duration ${duration})`, async () => {
    const context = vm.createContext({ duration });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/arrival-transitions.js'), 'utf8'), context);
    const animations = [];
    const container = {
      children: [],
      insertBefore(row, reference) {
        this.children = this.children.filter(child => child !== row);
        const index = reference ? this.children.indexOf(reference) : this.children.length;
        this.children.splice(index, 0, row);
      },
    };
    function row(key) {
      return {
        dataset: { key },
        isEqualNode: () => true,
        getBoundingClientRect() {
          return { top: container.children.indexOf(this) * 96, height: 96 };
        },
        remove() { container.children = container.children.filter(child => child !== this); },
        animate(frames, options) {
          assert.equal(options.duration, duration);
          let finish;
          const finished = new Promise(resolve => { finish = resolve; });
          animations.push({ row: this, frames, finish });
          return { finished };
        },
      };
    }
    const expired = row('expired');
    const alsoExpired = row('also-expired');
    const a = row('a');
    const b = row('b');
    const first = row('first');
    const middle = row('middle');
    const last = row('last');
    container.children = [expired, a, alsoExpired, b];
    context.container = container;
    context.nextRows = [first, row('b'), middle, row('a'), last];
    let completed = false;
    const refresh = vm.runInContext('updateArrivalRows(container, nextRows, duration)', context)
      .then(() => { completed = true; });

    if (duration) {
      assert.deepEqual(animations.map(animation => animation.row), [expired, alsoExpired]);
      assert.deepEqual(container.children, [expired, a, alsoExpired, b]);
      animations[0].finish();
      await new Promise(setImmediate);
      assert.deepEqual(container.children, [a, alsoExpired, b]);
      assert.equal(animations.length, 2);
      animations[1].finish();
      await new Promise(setImmediate);

      assert.deepEqual(container.children, [b, a]);
      assert.deepEqual(animations.slice(2).map(animation => animation.row), [b, a]);
      assert.equal(animations[2].frames[0].transform, 'translateY(96px)');
      assert.equal(animations[3].frames[0].transform, 'translateY(-96px)');
      animations[2].finish();
      await new Promise(setImmediate);
      assert.deepEqual(container.children, [b, a]);
      assert.equal(animations.length, 4);
      animations[3].finish();
      await new Promise(setImmediate);

      assert.deepEqual(container.children, [first, b, middle, a, last]);
      assert.deepEqual(animations.slice(4).map(animation => animation.row), [first, b, middle, a, last]);
      assert.equal(animations[5].frames[0].transform, 'translateY(-96px)');
      assert.equal(animations[7].frames[0].transform, 'translateY(-192px)');
      assert.equal(completed, false);
      animations.slice(4).forEach(animation => animation.finish());
    }
    await refresh;
    assert.deepEqual(container.children, [first, b, middle, a, last]);
    assert.equal(completed, true);
    if (!duration) assert.equal(animations.length, 0);

    animations.length = 0;
    context.nextRows = [];
    const clear = vm.runInContext('updateArrivalRows(container, nextRows, duration)', context);
    if (duration) {
      assert.equal(animations.length, 5);
      animations.forEach(animation => animation.finish());
    }
    await clear;
    assert.deepEqual(container.children, []);

    animations.length = 0;
    context.nextRows = [first, middle];
    const initial = vm.runInContext('updateArrivalRows(container, nextRows, duration)', context);
    await new Promise(setImmediate);
    if (duration) {
      assert.deepEqual(animations.map(animation => animation.row), [first, middle]);
      animations.forEach(animation => animation.finish());
    }
    await initial;
    assert.deepEqual(container.children, [first, middle]);
    if (!duration) assert.equal(animations.length, 0);
  });
}

test('refresh age counts elapsed seconds, resets on success, and uses one interval', () => {
  let now = 10000;
  let tick;
  let intervals = 0;
  const elements = {
    filterInfo: { hidden: true },
    filterMessage: { textContent: 'Walk time notice' },
    refreshSeparator: { hidden: true },
    refreshAge: { textContent: '' },
  };
  const context = vm.createContext({
    Date: { now: () => now },
    document: { getElementById: id => elements[id] },
    setInterval(callback, delay) {
      assert.equal(delay, 1000);
      tick = callback;
      intervals += 1;
      return intervals;
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/arrival-transitions.js'), 'utf8'), context);
  vm.runInContext('markArrivalsRefreshed()', context);
  assert.equal(elements.refreshAge.textContent, 'Refreshed 0 seconds ago');
  assert.equal(elements.filterInfo.hidden, false);
  assert.equal(elements.refreshSeparator.hidden, false);
  now += 5900;
  tick();
  assert.equal(elements.refreshAge.textContent, 'Refreshed 5 seconds ago');
  elements.filterMessage.textContent = '';
  vm.runInContext('markArrivalsRefreshed()', context);
  assert.equal(elements.refreshAge.textContent, 'Refreshed 0 seconds ago');
  assert.equal(elements.refreshSeparator.hidden, true);
  assert.equal(intervals, 1);
});

test('row identity ignores countdowns but distinguishes vehicles, stops, and directions', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/arrival-transitions.js'), 'utf8'), context);
  context.arrival = {
    route: 'Bus', routeNumber: '22', vehicleId: '4374',
    stationName: 'Clark & Lake', stopDescription: 'Northbound', destination: 'Howard',
  };
  const key = vm.runInContext('arrivalRowKey(arrival)', context);
  context.arrival.arrivalTime = 3;
  assert.equal(vm.runInContext('arrivalRowKey(arrival)', context), key);
  context.arrival.vehicleId = '4375';
  assert.notEqual(vm.runInContext('arrivalRowKey(arrival)', context), key);
});
