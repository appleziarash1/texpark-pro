/* Texpark Pro — the Firebase project's public keys, baked into the build.
 *
 * The owner asked that no device ever type these in, so they live here and every
 * device picks them up just by opening the site. There is nothing to set on the
 * phone or the PC.
 *
 * These two values are NOT secrets: they identify the project, they do not grant
 * access to it. The security is firestore.rules, which only lets the signed-in
 * account read and write its own shop. Signing in once per device (Settings ->
 * Cloud sync) is what keeps the shop private; the keys alone read nothing.
 *
 *   apiKey     Firebase console -> Project settings -> General -> Web API Key
 *   projectId  the project id
 *
 * You do NOT need to paste any database URL: the app derives it from projectId.
 */
window.FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDpuLR8j5xPQ2KPXLlUb4O66eoi56EhCYk',
  projectId: 'texpark-62700'
};
