import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { STORE_ORIGIN } from '../src/config/store.js';
import { productUrl } from '../src/scraper/productScraper.js';
import { PermanentError } from '../src/scraper/retry.js';

describe('scrape target guard', () => {
  it('only ever builds URLs on the INE mock store', () => {
    assert.equal(STORE_ORIGIN, 'https://demo.inelabteamdev.com');
    assert.equal(productUrl(88), 'https://demo.inelabteamdev.com/product/88');
    assert.ok(productUrl(1).startsWith(STORE_ORIGIN));
  });

  it('refuses anything that is not a positive integer product id', () => {
    // The scraper takes an id, never a URL, so a caller cannot redirect it at
    // another site.
    for (const bad of ['https://evil.example.com', '../../etc', 0, -1, 1.5, 'abc', null, undefined, '88; rm -rf /']) {
      assert.throws(() => productUrl(bad), PermanentError, `should reject ${JSON.stringify(bad)}`);
    }
  });

  it('coerces a numeric string id safely', () => {
    assert.equal(productUrl('88'), `${STORE_ORIGIN}/product/88`);
  });
});
