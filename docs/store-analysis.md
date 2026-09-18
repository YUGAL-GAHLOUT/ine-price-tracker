# Mock Store Analysis — https://demo.inelabteamdev.com

Findings from inspecting the SPA bundle (`/assets/index-*.js`) and live DOM.

## App shape
- React SPA (Vite). Server HTML is an empty `<div id="root">` — **nothing is server-rendered**.
- Routes: `/` (catalog) and `/product/:id`.

## Public JSON endpoints
| Endpoint | Returns |
|---|---|
| `GET /api/catalog?page=&pageSize=` | id, slug, name, brand, category, sku, description. **No price, no stock.** |
| `GET /api/product/:id` | same + specs + reviews. **No price, no stock.** |
| `GET /api/layout` | rotating obfuscated CSS class map + render variant |
| `GET /api/challenge` | `{salt, ts, difficulty, csig, wasm}` |

### Catalog pagination is randomly shuffled
`?page=1` returns different items on every call; `total` is always 1000. Pagination therefore
**cannot** enumerate the catalog. Product ids are dense in `1..1000`, so the reliable way to
build a search index is to walk `/api/product/:id` by id.

## Price is not in the HTML
Price/stock are only obtainable by completing an anti-bot pipeline in the browser:

1. Price block renders "Price hidden" + a **disabled** `Reveal price` button.
2. A behavioural gate (`class Ar`) records `mousemove` events over the price block,
   throttled to one per **40 ms**, capped at 40. Reveal stays disabled until
   `moves.length >= minMoves` **and** dwell `>= minDwellMs`.
3. On click: `GET /api/challenge` → compile & run the returned **WebAssembly** module,
   solve a **proof-of-work** (hash prefix of `difficulty` hex zeros) → `POST` the solution
   → receive a bearer `token` → `GET` the quote → payload is **XOR-encrypted with the token**.
4. Decrypted quote object:
   `{p:shown, m:mrp, n:sale, b:badgePct, s:stock, c:currency, t:at, r:rating,
     rc:ratingCount, sl:seller, dd:deliveryDays, v:variant, g:pending, f:format, x:triple}`

Reimplementing WASM + PoW + XOR in Node would be brittle and would break the moment the
challenge changes. **This is the case where a headless browser is genuinely required.**

## Deliberate traps

### 1. Decoy prices on the obvious selectors
Two **hidden** (`display:none`, `aria-hidden="true"`) elements carry *wrong* prices:
- `<span class="price-value">` — decoy #1
- `<span class="amount" data-price="true">` — decoy #2

The **real** price uses the rotating class from `/api/layout` → `classes.priceValue`,
plus a per-render random class `v<random>`. A scraper keying off `.price-value` or
`[data-price]` silently records the wrong number forever.

### 2. Rotating class names
`/api/layout` returns e.g. `{priceWrap:"pw-k2", priceValue:"pv-k2", mrp, sale, badge,
rating, seller, delivery, stock}` with a `revision` and `validUntil`. Layout must be
re-fetched per scrape; hardcoding classes breaks on rotation.

### 3. Six rotating price formats (`format` field)
| format | example |
|---|---|
| default | `₹1,234` |
| `spaced` | `₹1 234` |
| `euro` | `₹1.234,00` |
| `trailing` | `₹1,234/- (incl. of all taxes)` |
| `unicode` | full-width digits `₹１，２３４` |
| `nbsp` | every char joined by NBSP + zero-width space |
| `lakh` | `Rs.<NBSP>1,234` |

### 4. Split carrier
When `priceCarrier === "split"`, each character is wrapped in its own `<span>` with a
**zero-width space (U+200B)** between them. `textContent` must be stripped of U+200B/U+00A0.

### 5. Rotating stock phrasing
`stock > 0` → `<span class="stock-badge in-stock">` with one of 5 templates chosen by
`stock % 5`: `In stock · N left`, `Only N left`, `N in stock`, `Selling fast — N left`,
`Hurry, just N left`. `stock === 0` → `<span class="stock-badge out-stock">Out of stock</span>`.
The `in-stock`/`out-stock` classes are stable; the wording is not.

### 6. Injected faults
`Xn(fn)`: on 35% of loads — half the time the callback is **never invoked** (hangs forever),
otherwise it fires after a 900 ms delay. The store's own UI retries up to 6 times.

### 7. Cookie consent modal
A consent dialog overlays the page on first visit and blocks interaction. The scraper
dismisses it via the **Decline** button (privacy-preserving).

### 8. `pending` flag
`pending === true` renders the price at 45% opacity with an "Updating…" label — the figure
is **not final** and must not be stored as an observation.
