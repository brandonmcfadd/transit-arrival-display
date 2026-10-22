async function updateArrivalRows(container, nextRows, duration) {
  const existing = new Map(Array.from(container.children, row => [row.dataset.key, row]));
  const nextKeys = new Set(nextRows.map(row => row.dataset.key));
  const options = { duration, easing: 'ease-out' };
  const removed = Array.from(existing.values()).filter(row => !nextKeys.has(row.dataset.key));

  await Promise.all(removed.map(async row => {
    await row.animate([
      { height: `${row.getBoundingClientRect().height}px`, transform: 'translateY(0)', overflow: 'hidden', boxSizing: 'border-box' },
      { height: '0px', paddingTop: '0px', paddingBottom: '0px', transform: 'translateY(-100%)', overflow: 'hidden', boxSizing: 'border-box' },
    ], options).finished;
    row.remove();
    existing.delete(row.dataset.key);
  }));

  const positions = new Map(Array.from(existing.values(), row => [row, row.getBoundingClientRect().top]));
  const inserted = new Set();
  const rows = nextRows.map(next => {
    const row = existing.get(next.dataset.key);
    if (!row) {
      inserted.add(next);
      return next;
    }
    patchArrivalNode(row, next);
    return row;
  });
  rows.forEach((row, index) => {
    if (container.children[index] !== row) {
      container.insertBefore(row, container.children[index] || null);
    }
  });
  await Promise.all(rows.map(row => {
    const distance = inserted.has(row)
      ? row.getBoundingClientRect().height
      : positions.get(row) - row.getBoundingClientRect().top;
    if (!distance || !duration) return Promise.resolve();
    return row.animate([
      { transform: `translateY(${distance}px)` },
      { transform: 'translateY(0)' },
    ], options).finished;
  }));
}

function patchArrivalNode(node, next) {
  if (!node.isEqualNode(next)) {
    if (node.nodeType === Node.TEXT_NODE) {
      node.nodeValue = next.nodeValue;
      return;
    }
    for (const attribute of Array.from(node.attributes)) {
      if (!next.hasAttribute(attribute.name)) node.removeAttribute(attribute.name);
    }
    for (const attribute of next.attributes) {
      if (node.getAttribute(attribute.name) !== attribute.value) {
        node.setAttribute(attribute.name, attribute.value);
      }
    }
    Array.from(next.childNodes).forEach((child, index) => {
      const current = node.childNodes[index];
      if (!current) node.appendChild(child.cloneNode(true));
      else if (current.nodeType !== child.nodeType || current.nodeName !== child.nodeName) {
        node.replaceChild(child.cloneNode(true), current);
      } else patchArrivalNode(current, child);
    });
    while (node.childNodes.length > next.childNodes.length) node.lastChild.remove();
  }
}

let lastArrivalRefresh;
let refreshAgeInterval;

function markArrivalsRefreshed() {
  lastArrivalRefresh = Date.now();
  const update = () => {
    const seconds = Math.floor((Date.now() - lastArrivalRefresh) / 1000);
    document.getElementById('refreshAge').textContent = `Refreshed ${seconds} seconds ago`;
  };
  document.getElementById('filterInfo').hidden = false;
  document.getElementById('refreshSeparator').hidden =
    !document.getElementById('filterMessage').textContent;
  update();
  if (refreshAgeInterval === undefined) refreshAgeInterval = setInterval(update, 1000);
}

function arrivalRowKey(arrival) {
  return JSON.stringify([
    arrival.route,
    arrival.route === 'Bus' ? arrival.vehicleId : arrival.routeNumber,
    arrival.route === 'Bus' ? arrival.routeNumber : null,
    arrival.stationName,
    arrival.stopDescription,
    arrival.destination,
  ]);
}
