const jwt = require('jsonwebtoken');
const config = require('../config');

function signAccess(userId) {
  return jwt.sign({ sub: userId, type: 'access' }, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessExpires,
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
