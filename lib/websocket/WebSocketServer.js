var WebSocketServer = require('ws').Server;

/*!
 * ws: a node.js websocket client
 * Copyright(c) 2011 Einar Otto Stangvik <einaros@gmail.com>
 * MIT Licensed
 */

var crypto = require('crypto');
var WebSocket = require('ws/lib/WebSocket');
var Extensions = require('ws/lib/Extensions');
var PerMessageDeflate = require('ws/lib/PerMessageDeflate');
var url = require('url');

/**
 * Handle a HTTP Upgrade request.
 *
 * @api public
 */

WebSocketServer.prototype.handleUpgrade = function(req, socket, upgradeHead, cb) {
  // check for wrong path
  if (this.options.path) {
    var u = url.parse(req.url);
    if (u && u.pathname !== this.options.path) return;
  }
  var isHixie = req.headers['sec-websocket-key1'];
  if (typeof req.headers.upgrade === 'undefined' || req.headers.upgrade.toLowerCase() !== 'websocket'
    || isHixie) {
    abortConnection(socket, 400, isHixie ? 'Not support hixie-76' : 'Bad Request');
    return;
  }

  handleHybiUpgrade.apply(this, arguments);
};

/**
 * Entirely private apis,
 * which may or may not be bound to a sepcific WebSocket instance.
 */

function handleHybiUpgrade(req, socket, upgradeHead) {
  // handle premature socket errors
  var errorHandler = function() {
    try { socket.destroy(); } catch (e) {}
  };
  socket.on('error', errorHandler);

  // verify key presence
  if (!req.headers['sec-websocket-key']) {
    abortConnection(socket, 400, 'Bad Request');
    return;
  }

  // verify version
  var version = parseInt(req.headers['sec-websocket-version']);
  if ([8, 13].indexOf(version) === -1) {
    abortConnection(socket, 400, 'Bad Request');
    return;
  }

  // verify protocol
  var protocols = req.headers['sec-websocket-protocol'];

  // handle extensions offer
  var extensionsOffer = Extensions.parse(req.headers['sec-websocket-extensions']);

  // handler to call when the connection sequence completes
  var self = this;
  var completeHybiUpgrade2 = function(protocol) {

    // calc key
    var key = req.headers['sec-websocket-key'];
    var shasum = crypto.createHash('sha1');
    shasum.update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11');
    key = shasum.digest('base64');

    var headers = [
      'HTTP/1.1 101 Switching Protocols'
      , 'Upgrade: websocket'
      , 'Connection: Upgrade'
      , 'Sec-WebSocket-Accept: ' + key
    ];

    if (typeof protocol != 'undefined') {
      headers.push('Sec-WebSocket-Protocol: ' + protocol);
    }

    var extensions = {};
    try {
      extensions = acceptExtensions.call(self, extensionsOffer);
    } catch (err) {
      abortConnection(socket, 400, 'Bad Request');
      return;
    }

    if (Object.keys(extensions).length) {
      var serverExtensions = {};
      Object.keys(extensions).forEach(function(token) {
        serverExtensions[token] = [extensions[token].params];
      });
      headers.push('Sec-WebSocket-Extensions: ' + Extensions.format(serverExtensions));
    }

    var client = new WebSocket([req, socket, upgradeHead], {
      protocolVersion: version,
      protocol: protocol,
      extensions: extensions,
      maxPayload: self.options.maxPayload
    });

    if (self.options.clientTracking) {
      self.clients.push(client);
      client.on('close', function() {
        var index = self.clients.indexOf(client);
        if (index != -1) {
          self.clients.splice(index, 1);
        }
      });
    }
    var completeHandShake = function(err, code, name) {
      if (err) {
        return abortConnection(socket, code || 502, name || 'Bad Gateway');
      }
      // allows external modification/inspection of handshake headers
      self.emit('headers', headers);
      socket.setTimeout(0);
      socket.setNoDelay(true);
      try {
        socket.write(headers.concat('', '').join('\r\n'));
      }
      catch (e) {
        // if the upgrade write fails, shut the connection down hard
        try { socket.destroy(); } catch (e) {}
      }
      // signal upgrade complete
      socket.removeListener('error', errorHandler);
    };
    if (typeof self.onConnect === 'function') {
      self.onConnect(client, completeHandShake);
    } else {
      completeHandShake();
    }
  };

  // optionally call external protocol selection handler before
  // calling completeHybiUpgrade2
  var completeHybiUpgrade1 = function() {
    // choose from the sub-protocols
    if (typeof self.options.handleProtocols == 'function') {
      var protList = (protocols || '').split(/, */);
      var callbackCalled = false;
      self.options.handleProtocols(protList, function(result, protocol) {
        callbackCalled = true;
        if (!result) abortConnection(socket, 401, 'Unauthorized');
        else completeHybiUpgrade2(protocol);
      });
      if (!callbackCalled) {
            // the handleProtocols handler never called our callback
        abortConnection(socket, 501, 'Could not process protocols');
      }
      return;
    } else {
      if (typeof protocols !== 'undefined') {
        completeHybiUpgrade2(protocols.split(/, */)[0]);
      }
      else {
        completeHybiUpgrade2();
      }
    }
  };

  completeHybiUpgrade1();
}

function acceptExtensions(offer) {
  var extensions = {};
  var options = this.options.perMessageDeflate;
  var maxPayload = this.options.maxPayload;
  if (options && offer[PerMessageDeflate.extensionName]) {
    var perMessageDeflate = new PerMessageDeflate(options !== true ? options : {}, true, maxPayload);
    perMessageDeflate.accept(offer[PerMessageDeflate.extensionName]);
    extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
  }
  return extensions;
}

function abortConnection(socket, code, name) {
  try {
    var response = [
      'HTTP/1.1 ' + code + ' ' + name,
      'Content-type: text/html'
    ];
    socket.write(response.concat('', '').join('\r\n'));
  }
  catch (e) { /* ignore errors - we've aborted this connection */ }
  finally {
    // ensure that an early aborted connection is shut down completely
    try { socket.destroy(); } catch (e) {}
  }
}

module.exports = WebSocketServer;