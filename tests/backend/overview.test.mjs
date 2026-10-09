import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createAppServer } from '../../server/app.mjs';

const dataURL = new URL('../../.runtime/incidents.json', import.meta.url);

function params(options = {}) {
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    for (const item of Array.isArray(value) ? value : [value]) result.append(key, item);
  }
  return result;
}

function expected(rows, options = {}) {
  const query = (options.q ?? '').toLowerCase();
  const found = rows.filter(row =>
    ['id', 'title', 'description'].some(key => row[key].toLowerCase().includes(query)) &&
    ['service', 'status', 'severity'].every(key => !options[key]?.length || options[key].includes(row[key])) &&
    (!options.from || row.openedAt.slice(0, 10) >= options.from) &&
    (!options.to || row.openedAt.slice(0, 10) <= options.to));
  const groups = new Map();
  for (const row of found) {
    let group = groups.get(row.service);
    if (!group) {
      group = { service: row.service, incidentCount: 0, unresolvedCount: 0, highSeverityCount: 0, hours: [] };
      groups.set(row.service, group);
    }
    group.incidentCount++;
    if (row.status === 'open' || row.status === 'in_progress') group.unresolvedCount++;
    if (row.severity === 'critical' || row.severity === 'high') group.highSeverityCount++;
    if (row.status === 'resolved') group.hours.push((Date.parse(row.resolvedAt) - Date.parse(row.openedAt)) / 3600000);
  }
  return [...groups.values()].map(({ hours, ...group }) => ({
    ...group,
    averageResolutionHours: hours.length ? hours.reduce((sum, value) => sum + value, 0) / hours.length : null,
  })).sort((a, b) => b.unresolvedCount - a.unresolvedCount || (a.service < b.service ? -1 : a.service > b.service ? 1 : 0));
}

test('overview measures the complete filtered canonical result through loopback HTTP', async () => {
  const before = await readFile(dataURL);
  const rows = JSON.parse(before);
  const server = await createAppServer();
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const check = async (options = {}) => {
      const response = await fetch(`${base}/api/overview?${params(options)}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body, { services: expected(rows, options) });
      return body.services;
    };

    const all = await check();
    assert.equal(all.reduce((sum, service) => sum + service.incidentCount, 0), 2400);
    assert.ok(all.every(service => typeof service.averageResolutionHours === 'number'));
    assert.deepEqual(all.map(service => service.unresolvedCount), [...all].map(service => service.unresolvedCount).sort((a, b) => b - a));

    const filtered = { q: 'incident', service: ['Billing', 'Notifications'], status: ['open', 'in_progress'], severity: ['critical', 'high'], from: '2026-04-01', to: '2026-06-29' };
    const matching = rows.filter(row => ['id', 'title', 'description'].some(key => row[key].toLowerCase().includes('incident')) &&
      ['Billing', 'Notifications'].includes(row.service) && ['open', 'in_progress'].includes(row.status) &&
      ['critical', 'high'].includes(row.severity) && row.openedAt.slice(0, 10) >= filtered.from && row.openedAt.slice(0, 10) <= filtered.to);
    assert.ok(matching.length > 50, 'filtered result spans multiple pages at both supported page sizes');
    const expectedFiltered = await check(filtered);
    assert.ok(expectedFiltered.length > 0);
    for (const pageOptions of [
      { ...filtered, page: 1, pageSize: 25 },
      { ...filtered, page: 3, pageSize: 25, sort: 'severity', direction: 'asc' },
      { ...filtered, page: 2, pageSize: 50, sort: 'openedAt', direction: 'asc' },
    ]) assert.deepEqual(await check(pageOptions), expectedFiltered);

    const unresolved = await check({ status: ['open', 'in_progress'], page: 2, pageSize: 50 });
    assert.ok(unresolved.length > 0);
    assert.ok(unresolved.every(service => service.averageResolutionHours === null));
    assert.deepEqual(await check({ q: 'no such canonical incident' }), []);
  } finally {
    await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
    assert.deepEqual(await readFile(dataURL), before);
  }
});
