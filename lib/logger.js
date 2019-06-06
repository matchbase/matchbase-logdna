/*
 *  LogDNA NPM Module
 *      - supports levels (console.warn, Info, Notice, Warning, Error, Critical, Alert, Emerge)
 *      - supports Winston
 *      - supports Bunyan
 */

const bind = require('lodash.bind');
const clone = require('lodash.clonedeep');
const fetch = require('cross-fetch');
const forEach = require('lodash.foreach');
const isEqual = require('lodash.isequal');
const sizeof = require('object-sizeof');
const stringify = require('json-stringify-safe');
const validUrl = require('valid-url');
const querystring = require('querystring');
const Base64 = require('js-base64').Base64;

const configs = require('./configs');

var loggers = [];

const isInt = value =>
    !isNaN(value) && (parseFloat(value) | 0) === parseFloat(value);

const checkStringParam = (param, name, optional) => {
    if (optional && !param) return;
    if (!param || typeof param !== 'string') {
        throw new Error(`${name} is undefined or not passed as a String`);
    } else if (param.length > configs.MAX_INPUT_LENGTH) {
        throw new Error(
            `${name} cannot be longer than ${configs.MAX_INPUT_LENGTH} chars`
        );
    }
};

const isValidTimestamp = timestamp => {
    var valid = new Date(timestamp).getTime() > 0;
    if (!valid || Math.abs(timestamp - Date.now()) > configs.MS_IN_A_DAY) {
        console.warn(
            'Error: The timestamp used is either invalid or not within one day. Date.now() will be used in its place.'
        );
        return false;
    }
    return true;
};

function Logger(key, options) {
    if (!(this instanceof Logger)) return new Logger(key, options);

    checkStringParam(key, 'LogDNA Ingestion Key', false);
    checkStringParam(options.hostname, 'Hostname', true);
    checkStringParam(options.mac, 'MAC Address', true);
    checkStringParam(options.ip, 'IP Address', true);
    checkStringParam(options.level, 'Level', true);
    checkStringParam(options.app, 'App', true);
    checkStringParam(options.logdna_url, 'LogDNA URL', true);

    if (options.tags) {
        if (typeof options.tags === 'string') {
            options.tags = options.tags.split(',');
        }

        if (Array.isArray(options.tags)) {
            options.tags = options.tags
                .filter(tag => tag !== '')
                .map(tag => tag.trim())
                .join(',');
        } else throw new Error('Tags should be passed as a String or an Array');
    }

    if (options.timeout) {
        if (!isInt(options.timeout))
            throw new Error('Timeout must be an Integer');
        if (options.timeout > configs.MAX_REQUEST_TIMEOUT) {
            throw new Error(
                `Timeout cannot be longer than ${configs.MAX_REQUEST_TIMEOUT}`
            );
        }
    }

    if (options.hostname && !configs.HOSTNAME_CHECK.test(options.hostname)) {
        throw new Error('Invalid hostname');
    }

    if (options.mac && !configs.MAC_ADDR_CHECK.test(options.mac)) {
        throw new Error('Invalid MAC Address format');
    }

    if (options.ip && !configs.IP_ADDR_CHECK.test(options.ip)) {
        throw new Error('Invalid IP Address format');
    }

    if (options.logdna_url && !validUrl.isUri(options.logdna_url)) {
        throw new Error('Invalid URL');
    }

    this._max_length = options.max_length || true;
    this._index_meta = options.index_meta || false;
    this._flushLimit = configs.FLUSH_BYTE_LIMIT;
    this._url = options.logdna_url || configs.LOGDNA_URL;
    this._agent = new configs.AGENT_PROTOCOL(configs.AGENT_SETTING);
    this._bufByteLength = 0;
    this._buf = [];

    this.source = {
        hostname: options.hostname,
        app: options.app || 'default',
        level: options.level || 'INFO',
        env: options.env || undefined,
        tags: options.tags || undefined
    };

    this._req = {
        auth: { username: key },
        agent: this._agent,
        headers: clone(configs.DEFAULT_REQUEST_HEADER),
        qs: {
            hostname: this.source.hostname,
            mac: options.mac || undefined,
            ip: options.ip || undefined,
            tags: this.source.tags || undefined
        },
        timeout: options.timeout || configs.DEFAULT_REQUEST_TIMEOUT,
        withCredentials:
            options.with_credentials || configs.REQUEST_WITH_CREDENTIALS
    };

    const base64data = Base64.encode(`${key}`);

    this._req.headers.Authorization = 'Basic ' + base64data;
    loggers.push(this);
}

Logger.prototype.log = function(statement, opts) {
    this._err = false;
    if (typeof statement === 'object') {
        statement = JSON.parse(JSON.stringify(statement));
        statement = stringify(statement, null, 2, function() {
            return undefined;
        });
    }
    var message = {
        timestamp: Date.now(),
        line: statement,
        level: this.source.level,
        app: this.source.app,
        env: this.source.env
    };
    if (opts) {
        if (typeof opts === 'string') {
            if (opts.length > configs.MAX_INPUT_LENGTH) {
                console.warn(
                    'Level had more than ' +
                        configs.MAX_INPUT_LENGTH +
                        ' chars, was truncated'
                );
                opts = opts.substring(0, configs.MAX_INPUT_LENGTH);
            }
            message.level = opts;
        } else {
            if (typeof opts !== 'object') {
                this._err = true;
                console.warn(
                    'Can only pass a String or JSON object as additional parameter'
                );
            }
            message.level = opts.level || message.level;
            message.app = opts.app || message.app;
            message.env = opts.env || message.env;
            if (opts.timestamp && isValidTimestamp(opts.timestamp)) {
                message.timestamp = opts.timestamp;
            }
            if (opts.context && !opts.meta) {
                opts.meta = opts.context;
            }
            if (typeof opts.meta === 'object') {
                if (
                    opts.index_meta ||
                    (opts.index_meta === undefined && this._index_meta)
                ) {
                    message.meta = opts.meta;
                } else {
                    message.meta = stringify(opts.meta);
                }
            }
        }
    }
    if (this._err) {
        return this._err;
    }
    this._bufferLog(message);
};

Logger.prototype._bufferLog = function(message) {
    if (!message || !message.line) {
        console.warn('Ignoring empty message');
        return;
    }

    if (this._max_length && message.line.length > configs.MAX_LINE_LENGTH) {
        message.line =
            message.line.substring(0, configs.MAX_LINE_LENGTH) +
            ' (cut off, too long...)';
        console.warn(
            'Line was longer than ' +
                configs.MAX_LINE_LENGTH +
                ' chars and was truncated.'
        );
    }

    this._bufByteLength += sizeof(message);

    console.warn('Buffering message: %s', message.line);
    this._buf.push(message);

    if (this._bufByteLength >= this._flushLimit) {
        console.warn(
            'Buffer size meets (or exceeds) flush limit.  Immediately flushing'
        );
        this._flush(err => {
            if (err) {
                console.warn('Received an error while flushing...' + err);
            }
        });
    }

    if (!this._flusher) {
        console.warn(
            'No scheduled flush. Scheduling for %d ms from now.',
            configs.FLUSH_INTERVAL
        );
        this._flusher = setTimeout(
            bind(this._flush, this, err => {
                if (err) {
                    console.warn('Received an error while flushing...' + err);
                }
            }),
            configs.FLUSH_INTERVAL
        );
    }
};

Logger.prototype._flush = function(cb) {
    if (this._buf.length === 0) {
        console.warn('Nothing to flush');
        return cb && cb();
    }

    var sendbuf = { e: 'ls', ls: this._buf };
    var data = stringify(sendbuf);

    // BEFORE we clear the buffer, capture the lines being flushed for console.warn output
    var dbgLines = this._buf.map(function(msg) {
        return msg.line;
    });

    this._bufByteLength = 0;
    this._buf.length = 0;

    clearTimeout(this._flusher);
    this._flusher = null;

    this._req.qs.now = Date.now();

    var _url = this._url + '?' + querystring.stringify(this._req.qs);
    fetch(_url, {
        agent: this._req.agent,
        body: data,
        headers: this._req.headers,
        method: 'POST'
    })
        .then(response => {
            if (response) {
                if (response.status >= 400) {
                    console.warn(
                        'Encountered a 400 in POST Request: %j',
                        response
                    );
                } else {
                    console.warn('API success: %j', {
                        lines: dbgLines,
                        httpStatus: response.status,
                        body: response
                    });
                }
            } else {
                console.warn('Received no response from server');
            }
            return cb && cb();
        })
        .catch(err => {
            console.warn('Encountered an Error in POST Request: %j', err);
            return cb && cb(err);
        });
};

Logger.prototype._cleanUp = function(cb) {
    this._flush(cb);
    for (var i = 0; i < loggers.length; i++) {
        if (isEqual(loggers[i], this)) {
            loggers.splice(i, 1);
            return;
        }
    }
};

/*
 *  Populate short-hand for each supported Log Level
 */
forEach(configs.LOG_LEVELS, function(level) {
    var l = level.toLowerCase();
    Logger.prototype[l] = function(statement, opts) {
        opts = opts || {};
        opts.level = level;
        this.log(statement, opts);
    };
});

var flushAll = function(cb) {
    var expectedCallbacks = loggers.length;
    function callback() {
        if (expectedCallbacks-- <= 1) cb();
    }
    if (!expectedCallbacks) {
        cb();
    } else {
        for (var i = 0; i < loggers.length; i++) {
            loggers[i]._flush(callback);
        }
    }
};

exports.Logger = Logger;

exports.createLogger = function(key, options) {
    var next = new Logger(key, options);
    loggers.push(next);
    return next;
};

exports.flushAll = flushAll;
exports.cleanUpAll = function(cb) {
    flushAll(cb);
    loggers = [];
};
