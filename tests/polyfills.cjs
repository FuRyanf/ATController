const crypto = require('crypto');

if (typeof crypto.getRandomValues !== 'function' && crypto.webcrypto) {
  crypto.getRandomValues = function getRandomValues(array) {
    return crypto.webcrypto.getRandomValues(array);
  };
}

if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
  globalThis.crypto = crypto.webcrypto || crypto;
}
