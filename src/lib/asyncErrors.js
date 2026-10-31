'use strict';
// Express 4 only catches errors thrown synchronously by a handler. A
// rejected promise from an async handler escapes as an unhandledRejection,
// which terminates the Node process (one failed request = API down for
// everyone). This patch forwards such rejections to next(err), so the
// app's error handler answers them like any other error.
// Must be required before any router is created.
const Layer = require('express/lib/router/layer');

if (!Layer.prototype.__asyncErrorsPatched) {
  Layer.prototype.handle_request = function handle(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next();
    try {
      const out = fn(req, res, next);
      if (out && typeof out.then === 'function') {
        out.then(undefined, (err) => next(err || new Error('async handler rejected')));
      }
    } catch (err) {
      next(err);
    }
  };
  Layer.prototype.__asyncErrorsPatched = true;
}
