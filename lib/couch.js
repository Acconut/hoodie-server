/**
 * Starts a local CouchDB instance using the Hoodie app's data
 * directory for storage.
 */

var MultiCouch = require('multicouch');
var http_proxy = require('http-proxy');
var request = require('request');
var semver = require('semver');
var async = require('async');
var path = require('path');

var hconsole = require('./hconsole');

/**
 * Starts the CouchDB server using multicouch
 */

exports.startMultiCouch = function (config, callback) {

  // skip local couch server on some platforms (eg, nodejitsu)
  if (!config.couch.run) {
    console.log('Using remote CouchDB: ' + config.couch.url);
    return process.nextTick(callback);
  }

  // MultiCouch config object
  var couch_cfg = {
    port: config.couch.port,
    prefix: config.hoodie.app_path,
    couchdb_path: config.couch.bin,
    default_sys_ini: config.couch.default_ini,
    respawn: false, // otherwise causes problems shutting down on ctrl-c
    session_timeout: (60 * 60 * 24 * 2).toString() // 2 days
  };
  //console.log(['couch_cfg', couch_cfg]);

  // validate couchdb config
  if (!couch_cfg.couchdb_path) {
    return callback(new Error('No CouchDB binary found'));
  }

  if (!couch_cfg.default_sys_ini) {
    return callback(new Error('No CouchDB default.ini found'));
  }

  // starts a local couchdb server using the Hoodie app's data dir
  var couchdb = new MultiCouch(couch_cfg);

  // used to pass startup errors to callback
  var started = false;

  // local couchdb has started
  couchdb.on('start', function () {

    if (config.local_tld) {
      console.log('CouchDB started: ' + config.couch.local_url);
    } else {
      console.log(
        'CouchDB started: ' +
        'http://' + config.host + ':' + config.couch.port
      );
    }

    started = true;

    return callback();
  });

  // report errors from couchdb
  couchdb.on('error', function (err) {

    if (!started) {
      return callback(err); // pass startup error to callback
    } else {
      // log couchdb errors after server is started
      console.log('CouchDB Error: %j', err);
    }
  });

  // shutdown the couch server if the hoodie-app server is stopped
  process.on('exit', function (code) {
    exports.stop(couchdb, function () {
      process.exit(code);
    });
  });

  // on ctrl-c, stop couchdb first, then exit.
  process.on('SIGINT', function () {
    console.log(['sigint', arguments]);
    exports.stop(couchdb, function () {
      process.exit(0);
    });
  });

  couchdb.start();

  return couchdb;
};

/**
 * Polls CouchDB during startup so we know when we can make
 * requests against it
 */

exports.pollCouch = function (config, callback) {
  // when to stop polling and give up!
  var end = new Date().getTime() + 20000; // 20 second timeout
  var interval = 200; // poll every 200ms

  // relevant couchdb log files
  var logfiles = [
    '\t' + path.resolve(config.hoodie.app_path, 'couch.stderr'),
    '\t' + path.resolve(config.hoodie.app_path, 'couch.stdout'),
    '\t' + path.resolve(config.hoodie.app_path, 'couch.log')
  ];

  // start drawing a waiting indicator to console
  if (!config.boring) {
    var spinner = hconsole.spinner('Waiting for CouchDB', end);
  } else {
    console.log('Waiting for CouchDB...');
  }

  function _poll() {
    request(config.couch.url, function (err, res, body) {
      if (res && res.statusCode === 200) {
        // set Couch version so we can check later
        config.couch.version = JSON.parse(body).version;

        if (!config.boring) {
          spinner.success();
        }
        return callback();
      }
      else {
        // CouchDB not available yet
        if (new Date().getTime() >= end) {

          // Exceeded timeout value
          if (!config.boring) {
            spinner.failed();
          }
          return callback(new Error(
            'Timed out waiting for CouchDB. ' +
            'These logs may help:\n' +
            logfiles.join('\n')
          ));
        }
        // wait and try again
        return setTimeout(_poll, interval);
      }
    });
  }

  // start polling
  _poll();
};

/**
 * Checks CouchDB to see if it is at least version 1.2.0
 */

exports.checkCouchVersion = function (config, callback) {

  // 1.2.0 is our minimum supported version
  var compatible = semver.gte(config.couch.version, '1.2.0');

  if (compatible) {
    return callback();
  } else {
    return callback(new Error(
      'The version of CouchDB you are using is out of date.\n' +
      'Please update to the latest version of CouchDB.\n'
    ));
  }

};

/*
 * Starts the CouchDB server and waits for it to be responsive
 * before calling the callback
 */

exports.start = async.applyEachSeries([
  exports.startMultiCouch,
  exports.pollCouch,
  exports.checkCouchVersion
]);

/**
 * Stops the provided CouchDB server
 */

exports.stop = function (couchdb, callback) {
  console.log('\nStopping CouchDB...');
  couchdb.once('stop', callback);
  couchdb.stop();
};

/**
 * Proxy a HTTP request to CouchDB
 */

exports.proxy = function (config) {
  // where to send requests
  var target = {
    port: config.couch.port,
    host: config.couch.host
  };

  // create a http proxy to CouchDB
  http_proxy.setMaxSockets(1024);
  var proxy = new http_proxy.HttpProxy({
    target: target,
    changeOrigin: true,
    timeout: 60000
  });

  return function (url, req, res) {
    // rewrite request url
    req.url = url;
    // proxy request to CouchDB
    proxy.proxyRequest(req, res);
  };
};


/**
* Tests if the /_db_updates api is available at the provided
* CouchDB URL
*/

exports.dbUpdatesAvailable = function (couch, callback) {
  // bit of a hack to get around the lack of support for feed=normal on
  // the /_db_updates feature branch
  var q = {
    feed: 'longpoll',
    timeout: 0
  };
  couch.get('/_db_updates', q, function (err, data, res) {
    if (res && res.statusCode === 400) {
      // Bad Request response due to 'illegal database name'
      // This means it doesn't recognise /_db_updates as
      // a special root-level handler
      return callback(null, false);
    }
    if (err) {
      return callback(err);
    }
    return callback(null, true);
  });

};

