'use strict';

const http = require('http'),
  https = require('https'),
  async = require('async'),
  color = require('colorful'),
  certMgr = require('./lib/certMgr'),
  Recorder = require('./lib/recorder'),
  logUtil = require('./lib/log'),
  util = require('./lib/util'),
  events = require('events'),
  co = require('co'),
  WebInterface = require('./lib/webInterface'),
  wsServerMgr = require('./lib/wsServerMgr'),
  ThrottleGroup = require('stream-throttle').ThrottleGroup;

const T_TYPE_HTTP = 'http',
  T_TYPE_HTTPS = 'https',
  DEFAULT_TYPE = T_TYPE_HTTP;

const PROXY_STATUS_INIT = 'INIT';
const PROXY_STATUS_READY = 'READY';
const PROXY_STATUS_CLOSED = 'CLOSED';

/**
 *
 * @class ProxyCore
 * @extends {events.EventEmitter}
 */
class ProxyCore extends events.EventEmitter {
  /**
   * Creates an instance of ProxyCore.
   *
   * @param {object} config - configs
   * @param {number} config.port - port of the proxy server
   * @param {object} [config.rule=null] - rule module to use
   * @param {string} [config.type=http] - type of the proxy server, could be 'http' or 'https'
   * @param {strign} [config.hostname=localhost] - host name of the proxy server, required when this is an https proxy
   * @param {string[]} [config.hosts=[]] - requests to this hosts would be handled as request to the config webserver. 
   * @param {number} [config.throttle] - speed limit in kb/s
   * @param {boolean} [config.forceProxyHttps=false] - if proxy all https requests
   * @param {boolean} [config.silent=false] - if keep the console silent
   * @param {boolean} [config.dangerouslyIgnoreUnauthorized=false] - if ignore unauthorized server response
   * @param {object} [config.recorder] - recorder to use
   * @param {boolean} [config.wsIntercept] - whether intercept websocket
   * @param {http.Server} [config.httpProxyServer] - optional. using extra http server for proxy server
   * @param {http.RequestListener} [config.requestListener] - optional. current http application
   *
   * @memberOf ProxyCore
   */
  constructor(config) {
    super();
    config = config || { port: 8001 };

    this.status = PROXY_STATUS_INIT;
    this.proxyPort = config.port;
    this.proxyType = /https/i.test(config.type || DEFAULT_TYPE)
      ? T_TYPE_HTTPS
      : T_TYPE_HTTP;
    this.proxyHostName = config.hostname || 'localhost';
    this.recorder = config.recorder;
    this.currentHosts = util.getAllIpAddress().map(ip => `${ip}:${this.proxyPort}`).concat(`localhost:${this.proxyPort}`, `${this.proxyHostName}:${this.proxyPort}`);
    if (config.hosts) {
      this.currentHosts.concat(config.hosts);
    }

    if (parseInt(process.versions.node.split('.')[0], 10) < 4) {
      throw new Error('node.js >= v4.x is required for anyproxy');
    } else if (config.forceProxyHttps && !certMgr.ifRootCAFileExists()) {
      logUtil.printLog(
        'You can run `anyproxy-ca` to generate one root CA and then re-run this command'
      );
      throw new Error(
        'root CA not found. Please run `anyproxy-ca` to generate one first.'
      );
    } else if (this.proxyType === T_TYPE_HTTPS && !config.hostname) {
      throw new Error('hostname is required in https proxy');
    } else if (!this.proxyPort) {
      throw new Error('proxy port is required');
    } else if (!this.recorder) {
      throw new Error('recorder is required');
    } else if (
      config.forceProxyHttps &&
      config.rule &&
      config.rule.beforeDealHttpsRequest
    ) {
      logUtil.printLog(
        'both "-i(--intercept)" and rule.beforeDealHttpsRequest are specified, the "-i" option will be ignored.',
        logUtil.T_WARN
      );
      config.forceProxyHttps = false;
    }

    this.httpProxyServer = config.httpProxyServer;
    this.requestListener = config.requestListener;
    this.requestHandler = null;

    // copy the rule to keep the original proxyRule independent
    this.proxyRule = config.rule || {};

    if (config.silent) {
      logUtil.setPrintStatus(false);
    }

    if (config.throttle) {
      logUtil.printLog('throttle :' + config.throttle + 'kb/s');
      const rate = parseInt(config.throttle, 10);
      if (rate < 1) {
        throw new Error(
          'Invalid throttle rate value, should be positive integer'
        );
      }
      global._throttle = new ThrottleGroup({ rate: 1024 * rate }); // rate - byte/sec
    }

    // init recorder
    this.recorder = config.recorder;

    // init request handler
    const RequestHandler = util.freshRequire('./requestHandler');
    this.requestHandler = new RequestHandler(
      {
        wsIntercept: config.wsIntercept,
        httpServerPort: config.port, // the http server port for http proxy
        forceProxyHttps: !!config.forceProxyHttps,
        dangerouslyIgnoreUnauthorized: !!config.dangerouslyIgnoreUnauthorized,
        currentHosts: this.currentHosts,
        protocol: this.proxyType === T_TYPE_HTTPS ? 'wss' : 'ws',
      },
      this.proxyRule,
      this.recorder
    );
  }

  /**
   * manage all created socket
   * for each new socket, we put them to a map;
   * if the socket is closed itself, we remove it from the map
   * when the `close` method is called, we'll close the sockes before the server closed
   *
   * @param {Socket} the http socket that is creating
   * @returns undefined
   * @memberOf ProxyCore
   */
  handleExistConnections(socket) {
    const self = this;
    self.socketIndex++;
    const key = `socketIndex_${self.socketIndex}`;
    self.socketPool[key] = socket;

    // if the socket is closed already, removed it from pool
    socket.on('close', () => {
      delete self.socketPool[key];
    });
  }
  /**
   * Handle http request to this site
   * @param {http.IncomingMessage} req 
   * @param {http.ServerResponse} res 
   */
  handleUserRequest(req, res) {
    logUtil.info(`received request to: ${req.method} ${req.url}`);
    // proxy request start with http(s)://
    try {
      const url = new URL(req.url);
      // eslint-disable-next-line no-nested-ternary
      const host = url.hostname + (url.port ? ':' + url.port : util.isIp(url.hostname) ? ':80' : ''); // do not append port when hostname is not ip.
      if (this.currentHosts.includes(host)) {
        if (this.requestListener) {
          this.requestListener(req, res);
        } else {
          res.write('Hello world');
          res.end();
        }
      }
    } catch (ex) {
      res.write('Proxy server error, please contact the <a href="https://mattermost.garenanow.com/sea/messages/@xiaowei.xue">@xiaowei.xue</a>');
      res.end();
    }
  }

  /**
   * Handle http request to this site
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  handleProxyRequest(req, res) {
    const self = this;
    if (!self.currentHosts.includes(req.headers.host) && !res.finished) {
      self.requestHandler.userRequestHandler(req, res);
    }
  }
  /**
   * start the proxy server
   *
   * @returns ProxyCore
   *
   * @memberOf ProxyCore
   */
  start() {
    const self = this;
    self.socketIndex = 0;
    self.socketPool = {};

    if (self.status !== PROXY_STATUS_INIT) {
      throw new Error(
        'server status is not PROXY_STATUS_INIT, can not run start()'
      );
    }
    async.series(
      [
        //creat proxy server
        callback => {
          if (!this.httpProxyServer) {
            if (self.proxyType === T_TYPE_HTTPS) {
              certMgr.getCertificate(
                self.proxyHostName,
                (err, keyContent, crtContent) => {
                  if (err) {
                    callback(err);
                  } else {
                    self.httpProxyServer = https.createServer(
                      {
                        key: keyContent,
                        cert: crtContent,
                      },
                      self.handleUserRequest.bind(self),
                    );
                    callback(null);
                  }
                }
              );
            } else {
              self.httpProxyServer = http.createServer(
                self.handleUserRequest.bind(self),
              );
              callback(null);
            }
          } else {
            callback(null);
          }
        },
        callback => {
          self.httpProxyServer.on('request', self.handleProxyRequest.bind(self));
          callback(null);
        },

        //handle CONNECT request for https over http
        callback => {
          self.httpProxyServer.on(
            'connect',
            (req, socket, head) => {
              if (!self.currentHosts.includes(req.host)) { // do not proxy requests to this server
                self.requestHandler.connectReqHandler(req, socket, head);
              }
            }
          );

          callback(null);
        },

        callback => {
          wsServerMgr.getWsServer({
            server: self.httpProxyServer,
            connHandler: self.requestHandler.wsHandler,
          });
          // remember all sockets, so we can destory them when call the method 'close';
          self.httpProxyServer.on('connection', socket => {
            self.handleExistConnections.call(self, socket);
          });
          callback(null);
        },

        //start proxy server
        callback => {
          if (!self.httpProxyServer.listening) {
            self.httpProxyServer.listen(self.proxyPort);
          }
          callback(null);
        },
      ],

      //final callback
      (err, result) => {
        if (!err) {
          const tipText =
            (self.proxyType === T_TYPE_HTTP ? 'Http' : 'Https') +
            ' proxy started on port ' +
            self.proxyPort;
          logUtil.printLog(color.green(tipText));

          if (self.webServerInstance) {
            const webTip =
              'web interface started on port ' + self.proxyPort;
            logUtil.printLog(color.green(webTip));
          }

          let ruleSummaryString = '';
          const ruleSummary = this.proxyRule.summary;
          if (ruleSummary) {
            co(function* () {
              if (typeof ruleSummary === 'string') {
                ruleSummaryString = ruleSummary;
              } else {
                ruleSummaryString = yield ruleSummary();
              }

              logUtil.printLog(
                color.green(`Active rule is: ${ruleSummaryString}`)
              );
            });
          }

          self.status = PROXY_STATUS_READY;
          self.emit('ready');
        } else {
          const tipText = 'err when start proxy server :(';
          logUtil.printLog(color.red(tipText), logUtil.T_ERR);
          logUtil.printLog(err, logUtil.T_ERR);
          self.emit('error', {
            error: err,
          });
        }
      }
    );

    return self;
  }

  /**
   * close the proxy server
   *
   * @returns ProxyCore
   *
   * @memberOf ProxyCore
   */
  close() {
    // clear recorder cache
    return new Promise(resolve => {
      if (this.httpProxyServer) {
        // destroy conns & cltSockets when closing proxy server
        for (const connItem of this.requestHandler.conns) {
          const key = connItem[0];
          const conn = connItem[1];
          logUtil.printLog(`destorying https connection : ${key}`);
          conn.end();
        }

        for (const cltSocketItem of this.requestHandler.cltSockets) {
          const key = cltSocketItem[0];
          const cltSocket = cltSocketItem[1];
          logUtil.printLog(`closing https cltSocket : ${key}`);
          cltSocket.end();
        }

        if (this.requestHandler.httpsServerMgr) {
          this.requestHandler.httpsServerMgr.close();
        }

        if (this.socketPool) {
          for (const key in this.socketPool) {
            this.socketPool[key].destroy();
          }
        }

        this.httpProxyServer.close(error => {
          if (error) {
            console.error(error);
            logUtil.printLog(
              `proxy server close FAILED : ${error.message}`,
              logUtil.T_ERR
            );
          } else {
            this.httpProxyServer = null;

            this.status = PROXY_STATUS_CLOSED;
            logUtil.printLog(
              `proxy server closed at ${this.proxyHostName}:${this.proxyPort}`
            );
          }
          resolve(error);
        });
      } else {
        resolve();
      }
    });
  }
}

/**
 * start proxy server as well as recorder and webInterface
 */
class ProxyServer extends ProxyCore {
  /**
   *
   * @param {object} config - config
   * @param {object} [config.webInterface] - config of the web interface
   * @param {boolean} [config.webInterface.enable=false] - if web interface is enabled
   * @param {number} [config.webInterface.webPort=8002] - http port of the web interface
   */
  constructor(config) {
    // prepare a recorder
    const recorder = new Recorder();
    const configForCore = Object.assign(
      {
        recorder,
      },
      config
    );

    super(configForCore);

    this.proxyWebinterfaceConfig = config.webInterface;
    this.recorder = recorder;
    this.webServerInstance = null;
    this.webServerApp = null;
  }


  /**
   * Handle http request to this site
   * @param {http.IncomingMessage} req 
   * @param {http.ServerResponse} res 
   */
  handleUserRequest(req, res) {
    logUtil.info(`received request to: ${req.method} ${req.url}`);
    // proxy request start with http(s)://
    try {
      const url = new URL(req.url);
      // eslint-disable-next-line no-nested-ternary
      const host = url.hostname + (url.port ? ':' + url.port : util.isIp(url.hostname) ? ':80' : ''); // do not append port when hostname is not ip.
      if (this.currentHosts.includes(host)) {
        if (this.requestListener) {
          this.requestListener(req, res);
        } else if (this.webServerApp) {
          this.webServerApp(req, res);
        } else {
          res.write('Hello world');
          res.end();
        }
      }
    } catch (ex) {
      res.write('Proxy server error, please contact the <a href="https://mattermost.garenanow.com/sea/messages/@xiaowei.xue">@xiaowei.xue</a>');
      res.end();
    }
  }

  start() {
    if (this.recorder) {
      this.recorder.setDbAutoCompact();
    }

    // start web interface if neeeded
    if (this.proxyWebinterfaceConfig && this.proxyWebinterfaceConfig.enable) {
      this.webServerInstance = new WebInterface(
        this.proxyWebinterfaceConfig,
        this.recorder
      );
      // start web server
      this.webServerApp = this.webServerInstance.getServer();
      super.start();
    } else {
      super.start();
    }
  }

  close() {
    const self = this;
    // release recorder
    if (self.recorder) {
      self.recorder.stopDbAutoCompact();
      self.recorder.clear();
    }
    self.recorder = null;

    // close ProxyCore
    return (
      super
        .close()
        // release webInterface
        .then(() => {
          if (self.webServerInstance) {
            const tmpWebServer = self.webServerInstance;
            self.webServerInstance = null;
            logUtil.printLog('closing webInterface...');
            return tmpWebServer.close();
          }
        })
    );
  }
}

module.exports.ProxyCore = ProxyCore;
module.exports.ProxyServer = ProxyServer;
module.exports.ProxyRecorder = Recorder;
module.exports.ProxyWebServer = WebInterface;
module.exports.utils = {
  systemProxyMgr: require('./lib/systemProxyMgr'),
  certMgr,
  os: require('./lib/util'),
};
