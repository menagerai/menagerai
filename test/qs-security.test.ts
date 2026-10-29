import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rootRequire = createRequire(resolve('package.json'));
const lock = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8'));
const qsEntries = Object.entries(lock.packages).filter(([path]) => /(^|\/)node_modules\/qs$/.test(path));

describe('qs security (GHSA-6pq8-jhm2-2vcw)', () => {
  it('locks every qs copy to the patched compatible 6.x line', () => {
    expect(qsEntries.length).toBeGreaterThan(0);
    for (const [path, entry] of qsEntries) {
      const version = (entry as { version: string }).version;
      const [major, minor, patch] = version.split('.').map(Number);
      expect(major, path).toBe(6);
      expect(minor > 16 || (minor === 16 && patch >= 1), `${path}: ${version}`).toBe(true);
    }
  });

  // Resolve from each actual consumer, not just a potentially safe root copy.
  for (const consumer of ['express', 'body-parser', 'superagent']) {
    const consumerRequire = createRequire(rootRequire.resolve(consumer));
    const qs = consumerRequire('qs');

    describe(consumer, () => {
      it.each([false, true])('serializes hostile comma-array elements without throwing (encodeValuesOnly=%s)', (encodeValuesOnly) => {
        const hostile = JSON.parse('{"a":[{"toString":"x"}]}');
        expect(qs.stringify(hostile, { arrayFormat: 'comma', encodeValuesOnly }))
          .toBe('a=%5Bobject%20Object%5D');
      });

      it('serializes null-prototype comma-array elements without throwing', () => {
        const input = qs.parse('a[0][toString]=x', { plainObjects: true });
        expect(qs.stringify(input, { arrayFormat: 'comma' })).toBe('a=%5Bobject%20Object%5D');
      });

      it('preserves normal comma serialization and nested query parsing', () => {
        expect(qs.stringify({ a: ['one', 'two'] }, { arrayFormat: 'comma' })).toBe('a=one%2Ctwo');
        expect(qs.parse('filter[name]=alice&roles[]=reader&roles[]=writer'))
          .toEqual({ filter: { name: 'alice' }, roles: ['reader', 'writer'] });
      });
    });
  }
});
