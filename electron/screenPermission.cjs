'use strict';

/** Only foreground, user-initiated display requests from the trusted UI may reach the modal picker. */
function canChooseScreen(request, trustedOrigin, locked) {
  if (locked || request?.userGesture !== true || request?.videoRequested !== true || request?.audioRequested === true) return false;
  try { return new URL(request.securityOrigin).origin === trustedOrigin; }
  catch { return false; }
}
module.exports = { canChooseScreen };
