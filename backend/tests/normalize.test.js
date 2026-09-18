import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parsePrice, parseStock } from '../src/scraper/normalize.js';

const ZWSP = '​';
const NBSP = ' ';

describe('parsePrice — every format the store rotates through', () => {
  const cases = [
    ['default',  '₹25,739', 25739],
    ['spaced',   '₹25 739', 25739],
    ['euro',     '₹25.739,00', 25739],
    ['trailing', '₹25,739/- (incl. of all taxes)', 25739],
    ['unicode',  '₹２５,７３９', 25739],
    ['lakh',     `Rs.${NBSP}25,739.00`, 25739],
    ['nbsp',     '₹25,739'.split('').join(`${NBSP}${ZWSP}`), 25739],
    // "split" carrier wraps each character in its own span, separated by ZWSP.
    ['split+euro', `₹${ZWSP}2${ZWSP}5${ZWSP}.${ZWSP}7${ZWSP}3${ZWSP}9${ZWSP},${ZWSP}0${ZWSP}0`, 25739],
  ];

  for (const [name, input, expected] of cases) {
    it(`parses the ${name} format`, () => assert.equal(parsePrice(input), expected));
  }

  it('parses an Indian-grouped lakh figure', () => {
    assert.equal(parsePrice('₹1,25,739'), 125739);
  });

  it('keeps genuine paise', () => {
    assert.equal(parsePrice('₹1,299.50'), 1299.5);
  });
});

describe('parsePrice — refuses anything it does not understand', () => {
  for (const bad of [null, undefined, 42, '', '   ', 'Price hidden', 'Couldn’t load the price', 'N/A', '₹', '₹abc']) {
    it(`returns null for ${JSON.stringify(bad)}`, () => assert.equal(parsePrice(bad), null));
  }

  it('rejects a price of zero', () => assert.equal(parsePrice('₹0'), null));

  it('rejects an absurdly large figure rather than guessing', () => {
    assert.equal(parsePrice('₹99,99,99,999'), null);
  });
});

describe('parseStock', () => {
  it('reads each of the five in-stock phrasings', () => {
    const phrasings = [
      'In stock · 32 left',
      'Only 32 left',
      '32 in stock',
      'Selling fast — 32 left',
      'Hurry, just 32 left',
    ];
    for (const text of phrasings) {
      assert.deepEqual(parseStock({ className: 'stock-badge in-stock', text }), { inStock: true, quantity: 32 });
    }
  });

  it('reads out of stock as a real observation, not a failure', () => {
    assert.deepEqual(
      parseStock({ className: 'stock-badge out-stock', text: 'Out of stock' }),
      { inStock: false, quantity: 0 },
    );
  });

  it('treats a MISSING badge as a failure, not as out of stock', () => {
    // This distinction is the whole point: a scraper that reports "out of stock"
    // when it simply failed to find the element writes false history.
    assert.equal(parseStock(null), null);
    assert.equal(parseStock(undefined), null);
    assert.equal(parseStock({ text: '5 left' }), null);
  });

  it('fails rather than guessing when the badge class is unrecognised', () => {
    assert.equal(parseStock({ className: 'stock-badge', text: '5 left' }), null);
    assert.equal(parseStock({ className: 'stock-badge unknown-state', text: '5 left' }), null);
  });

  it('fails when an in-stock badge carries no usable quantity', () => {
    assert.equal(parseStock({ className: 'stock-badge in-stock', text: 'In stock' }), null);
    assert.equal(parseStock({ className: 'stock-badge in-stock', text: '' }), null);
  });

  it('fails when the text is ambiguous (more than one number)', () => {
    assert.equal(parseStock({ className: 'stock-badge in-stock', text: '3 of 12 left' }), null);
  });

  it('handles zero-width noise inside the quantity', () => {
    assert.deepEqual(
      parseStock({ className: 'stock-badge in-stock', text: `3${ZWSP}2${NBSP}in stock` }),
      { inStock: true, quantity: 32 },
    );
  });
});
