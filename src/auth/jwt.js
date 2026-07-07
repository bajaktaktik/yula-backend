const jwt = require('jsonwebtoken');
const config = require('../config');

function signAccess(userId, opts = {}) {
  // opts.scope: özel scope (örn. 'totp_setup') — normal access token'dan ayırt için
  // opts.expiresIn: özel süre (örn. '10m' — TOTP setup için kısa)
  const payload = { sub: userId, type: 'access' };
  if (opts.scope) payload.scope = opts.scope;
  return jwt.sign(payload, config.jwt.accessSecret, {
    expiresIn: opts.expiresIn || config.jwt.accessExpires,
  });
}
function signRefresh(userId) {
  return jwt.sign({ sub: userId, type: 'refresh' }, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpires,
  });
}
function verifyAccess(token) {
  return jwt.verify(token, config.jwt.accessSecret);
}
function verifyRefresh(token) {
  return jwt.verify(token, config.jwt.refreshSecret);
}

module.exports = { signAccess, signRefresh, verifyAccess, verifyRefresh };
