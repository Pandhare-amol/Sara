'use strict';

const fs = require('fs');
const path = require('path');

/** Keep the Electron native-capture guard and child backend on the same data
 * directory. Do not treat a blank env var as a custom folder. When launching
 * under the supervisor its SARA_DATA_DIR is already absolute; in standalone
 * Electron a relative path is interpreted relative to the app root (child cwd).
 */
function backendDataDir(appRoot, appUserData, configuredDataDir) {
  return configuredDataDir ? path.resolve(appRoot, configuredDataDir) : appUserData;
}

function protectedDatastoreExists({ required, appRoot, appUserData, configuredDataDir }) {
  if (required) return true;
  // Include both the configured backend path and existing desktop/default
  // locations so an older or independently launched protected installation
  // cannot inadvertently allow capture because of a config-path mismatch.
  const candidates = new Set([
    backendDataDir(appRoot, appUserData, configuredDataDir),
    appUserData,
    path.join(appRoot, 'data'),
  ]);
  for (const directory of candidates) {
    if (fs.existsSync(path.join(directory, 'security', 'multiuser.json')) ||
        fs.existsSync(path.join(directory, 'security', 'multiuser.pending'))) return true;
  }
  return false;
}

module.exports = { backendDataDir, protectedDatastoreExists };
