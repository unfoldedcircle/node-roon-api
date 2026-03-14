/**
 * Central log functions.
 *
 * Use [debug](https://www.npmjs.com/package/debug) module for logging.
 */

const debug = require("debug");

const log = {
  msgTrace: debug("roonapi:msg"),
  debug: debug("roonapi:debug"),
  info: debug("roonapi:info"),
  warn: debug("roonapi:warn"),
  error: debug("roonapi:error")
};

exports = module.exports = log;
