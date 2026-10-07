/* Texpark Pro — your Firebase project's public keys.
 *
 * Fill this in once, on the machine that creates the Firebase project, then copy
 * the filled file to every device (or just paste the two values into Settings ->
 * Cloud sync, which stores them in this browser). See docs/FIRESTORE_SETUP_BANGLA.txt.
 *
 * These two values are NOT secrets: they identify the project, they do not grant
 * access to it. The security is firestore.rules, which only lets the signed-in
 * account read and write its own shop. Leaving them blank is fine - the app then
 * keeps using the Google Sheet exactly as before.
 *
 *   apiKey     Firebase console -> Project settings -> General -> Web API Key
 *   projectId  the project id, e.g. "texpark-pro-8f21c"
 *
 * You do NOT need to paste any database URL: the app derives it from projectId.
 */
window.FIREBASE_CONFIG = {
  apiKey: '',
  projectId: ''
};
