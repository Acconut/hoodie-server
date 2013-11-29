var http = require('http');

/**
 * Creates a proxy server to handle nodejitsu requests based on subdomain
 */

module.exports = function (config, callback) {
  // skip this server if not on nodejitsu
  if (!config.run_nodejitsu_server) {
    return callback();
  }

  var server = http.createServer(function (req, res) {

    if (/^admin\./.test(req.headers.host)) {
      // respond using admin server when host matches admin.*
      config.admin_server.emit('request', req, res);
    } else {
      // respond using www server by default
      config.www_server.emit('request', req, res);
    }

  }).listen(8080, config.host, callback);

  config.nodejitsu_server = server;
  return server;
};
