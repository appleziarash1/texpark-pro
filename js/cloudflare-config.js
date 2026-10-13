/* Texpark Pro - Cloudflare sync endpoint, baked into the build.
 *
 * This is the replacement backend for Firebase Firestore: a Cloudflare Worker plus one
 * Durable Object per shop (see /cloudflare). The Worker pushes every change to the
 * other devices over a WebSocket, so a change lands in ~0.1s.
 *
 * The URL is public, so it is baked here. The shop TOKEN is a secret and is NOT baked
 * here - this repository is public, and a token in a committed file would let anyone
 * read and write the shop. The token is delivered per device through the private setup
 * link instead: open the app, go to Settings -> Cloud sync -> Connect, and paste the
 * link (or the token). A device with no token simply does not use this backend.
 *
 * To turn it on:
 *   1. cd cloudflare && npx wrangler deploy         (or the GitHub Action)
 *   2. npx wrangler secret put AUTH_TOKEN           (paste a long random token)
 *   3. put the deployed URL below, set backend to 'cloudflare', and push
 *   4. on each device, open Settings -> Cloud sync -> Connect and paste
 *      <site>/#cloud=<base64('cf|' + that same token)>  once
 *
 * While `backend` is not 'cloudflare', or the URL is blank, the app keeps using
 * Firebase exactly as before - nothing else changes.
 */
window.CLOUDFLARE_SYNC = {
  backend: 'cloudflare',            // 'cloudflare' | 'firebase'
  url: 'https://texpark-sync.apple-ziarash1.workers.dev',                        // e.g. 'https://texpark-sync.<you>.workers.dev'
  token: ''                       // leave blank: the token arrives via the private link
};
