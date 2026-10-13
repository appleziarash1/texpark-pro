/* Texpark Pro - Cloudflare sync endpoint, baked into the build.
 *
 * This is the replacement backend for Firebase Firestore. It is a Cloudflare Worker
 * plus one Durable Object per shop (see /cloudflare). The URL and the shop token are
 * public build values: the token is the ONLY thing guarding the shop, so treat it like
 * the shop password. It is baked here so no device ever types anything - opening the
 * site is the whole setup.
 *
 * To turn it on:
 *   1. cd cloudflare && npx wrangler deploy
 *   2. npx wrangler secret put AUTH_TOKEN      (paste the token below when asked)
 *   3. put the deployed URL and that same token here, and set backend to 'cloudflare'
 *
 * While `backend` is not 'cloudflare', or these are blank, the app keeps using
 * Firebase exactly as before - nothing else changes.
 */
window.CLOUDFLARE_SYNC = {
  backend: 'firebase',            // 'cloudflare' | 'firebase'
  url: '',                        // e.g. 'https://texpark-sync.<you>.workers.dev'
  token: ''                       // the same AUTH_TOKEN you set with wrangler secret
};
