/**
 * The one and only host this application is allowed to scrape.
 *
 * Kept in its own module (with no environment dependencies) so that nothing can
 * make the target configurable, and so the scraper can be exercised without a
 * database configured.
 */
export const STORE_ORIGIN = 'https://demo.inelabteamdev.com';
