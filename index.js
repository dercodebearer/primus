'use strict';

var EventEmitter = require('events').EventEmitter
  , Transformer = require('./transformer')
  , Spark = require('./spark')
  , fs = require('fs');

/**
 * Primus is a universal wrapper for real-time frameworks that provides a common
 * interface for server and client interaction.
 *
 * @constructor
 * @param {HTTP.Server} server HTTP or HTTPS server instance.
 * @param {Object} options Configuration
 * @api public
 */
function Primus(server, options) {
  if (!(this instanceof Primus)) return new Primus(server, options);

  options = options || {};

  this.transformer = null;                // Reference to the real-time engine instance.
  this.encoder = null;                    // Shorthand to the parser's encoder.
  this.decoder = null;                    // Shorthand to the parser's decoder.
  this.sparks = 0;                        // Increment id for connection ids
  this.connected = 0;                     // Connection counter;
  this.connections = Object.create(null); // Connection storage.

  this.server = server;
  this.pathname = options.pathname || '/primus';

  //
  // Create a specification file with the information that people might need to
  // connect to the server.
  //
  this.spec = {
    version: this.version,
    pathname: this.pathname
  };

  this.parsers(options.parser);
  this.Spark = Spark.bind(Spark, this);
  this.initialise(options.transformer || options.transport, options);
}

Primus.prototype.__proto__ = EventEmitter.prototype;

//
// Lazy read the primus.js JavaScript client.
//
Object.defineProperty(Primus.prototype, 'client', {
  get: function read() {
    read.primus = read.primus || fs.readFileSync(__dirname + '/primus.js', 'utf-8');
    return read.primus;
  }
});

//
// Lazy compile the primus.js JavaScript client for Node.js
//
Object.defineProperty(Primus.prototype, 'Socket', {
  get: function () {
    return require('load').compiler(this.library(true), 'primus.js', {
      __filename: 'primus.js',
      __dirname: __dirname
    });
  }
});

//
// Expose the current version number.
//
Primus.prototype.version = require('./package.json').version;

//
// A list of supported transformers and the required Node.js modules.
//
Primus.transformers = require('./transformers.json');
Primus.parsers = require('./parsers.json');

/**
 * The Ark contains all our plugins definitions. It's namespaced by
 * name=>plugin.
 *
 * @type {Object}
 * @private
 */
Primus.prototype.ark = Object.create(null);

/**
 * Simple function to output common errors.
 *
 * @param {String} what What is missing.
 * @param {Object} where Either Primus.parsers or Primus.transformers.
 * @returns {Object}
 * @api private
 */
Primus.prototype.is = function is(what, where) {
  var missing = Primus.parsers !== where
      ? 'transformer'
      : 'parser'
    , dependency = where[what];

  return {
    missing: function write() {
      console.error('Primus:');
      console.error('Primus: Missing required npm dependency for '+ what);
      console.error('Primus: Please run the following command and try again:');
      console.error('Primus:');
      console.error('Primus:   npm install --save %s', dependency.server);
      console.error('Primus:');

      return 'Missing dependencies for '+ missing +': "'+ what + '"';
    },

    unknown: function write() {
      console.error('Primus:');
      console.error('Primus: Unsupported %s: "%s"', missing, what);
      console.error('Primus: We only support the following %ss:', missing);
      console.error('Primus:');
      console.error('Primus:   %s', Object.keys(where).join(', '));
      console.error('Primus:');

      return 'Unsupported '+ missing +': "'+ what +'"';
    }
  };
};

/**
 * Initialise the real-time transport that was chosen.
 *
 * @param {Mixed} Transformer The name of the transformer or a constructor;
 * @param {Object} options Options.
 * @api private
 */
Primus.prototype.initialise = function initialise(Transformer, options) {
  Transformer = Transformer || 'websockets';

  var primus = this
    , transformer
    , plugin
    , name;

  if ('string' === typeof Transformer) {
    Transformer = transformer = Transformer.toLowerCase();
    this.spec.transformer = transformer;

    //
    // This is a unknown transporter, it could be people made a typo.
    //
    if (!(Transformer in Primus.transformers)) {
      throw new Error(this.is(Transformer, Primus.transformers).unknown());
    }

    try {
      Transformer = require('./transformers/'+ transformer);
      this.transformer = new Transformer(this);
    } catch (e) {
      throw new Error(this.is(transformer, Primus.transformers).missing());
    }
  } else {
    this.spec.transformer = 'custom';
  }

  if ('function' !== typeof Transformer) {
    throw new Error('The given transformer is not a constructor');
  }

  this.transformer = this.transformer || new Transformer(this);

  this.on('connection', function connection(stream) {
    this.connected++;
    this.connections[stream.id] = stream;
  });

  this.on('disconnection', function disconnected(stream) {
    this.connected--;
    delete this.connections[stream.id];
  });

  for (name in this.ark) {
    plugin = this.ark[name];

    if (!plugin.server) continue;
    plugin.server.call(this, this, options);
  }

  //
  // Emit the initialised event after the next tick so we have some time to
  // attach listeners.
  //
  process.nextTick(function tock() {
    primus.emit('initialised', primus.transformer, primus.parser);
  });
};

/**
 * Iterate over the connections.
 *
 * @param {Function} fn The function that is called every iteration.
 * @api public
 */
Primus.prototype.forEach = function forEach(fn) {
  for (var stream in this.connections) {
    fn(this.connections[stream], stream, this.connections);
  }

  return this;
};

/**
 * Install message parsers.
 *
 * @param {Mixed} parser Parse name or parser Object.
 * @api private
 */
Primus.prototype.parsers = function parsers(parser) {
  parser = parser || 'json';

  if ('string' === typeof parser) {
    parser = parser.toLowerCase();
    this.spec.parser = parser;

    //
    // This is a unknown parser, it could be people made a typo.
    //
    if (!(parser in Primus.parsers)) {
      throw new Error(this.is(parser, Primus.parsers).unknown());
    }

    try { parser = require('./parsers/'+ parser); }
    catch (e) {
      throw new Error(this.is(parser, Primus.parsers).missing());
    }
  } else {
    this.spec.parser = 'custom';
  }

  if ('object' !== typeof parser) {
    throw new Error('The given parser is not an Object.');
  }

  this.encoder = parser.encoder;
  this.decoder = parser.decoder;
  this.parser = parser;

  return this;
};

/**
 * Generate a client library.
 *
 * @param {Boolean} nodejs Don't include the library, as we're running on Node.js.
 * @returns {String} The client library.
 * @api public
 */
Primus.prototype.library = function compile(nodejs) {
  var encoder = this.encoder.client || this.encoder
    , decoder = this.decoder.client || this.decoder
    , library = [ !nodejs ? this.transformer.library : null ]
    , transport = this.transformer.client
    , parser = this.parser.library || '';

  //
  // Add a simple export wrapper so it can be used as Node.js, amd or browser
  // client.
  //
  var client = [
    '(function (name, context, definition) {',
    '  if (typeof module !== "undefined" && module.exports) {',
    '    module.exports = definition();',
    '  } else if (typeof define == "function" && define.amd) {',
    '    define(definition);',
    '  } else {',
    '    context[name] = definition();',
    '  }',
    '})("Primus", this, function PRIMUS() {',
    this.client
  ].join('\n');

  //
  // Replace some basic content.
  //
  client = client
    .replace('null; // @import {primus::pathname}', '"'+ this.pathname.toString() +'"')
    .replace('null; // @import {primus::version}', '"'+ this.version +'"')
    .replace('null; // @import {primus::transport}', transport.toString())
    .replace('null; // @import {primus::encoder}', encoder.toString())
    .replace('null; // @import {primus::decoder}', decoder.toString());

  //
  // Add the parser inside the closure, to prevent global leaking.
  //
  if (parser && parser.length) client += parser;

  //
  // Iterate over the parsers, and register the client side plugins. If there's
  // a library bundled, add it the library array as there were some issues with
  // frameworks that get included in module wrapper as it forces strict mode.
  //
  var name, plugin;
  for (name in this.ark) {
    plugin = this.ark[name];
    name = JSON.stringify(name);

    if (!plugin.client) continue;
    if (plugin.library) library.push(plugin.library);

    client += 'Primus.prototype.ark['+ name +'] = '+ plugin.client.toString() + '\n';
  }

  //
  // Close the export wrapper and return the client. If we need to add
  // a library, we should add them after we've created our closure and module
  // exports. Some libraries seem to fail hard once they are wrapped in our
  // closure so I'll rather expose a global variable instead of having to monkey
  // patch to much code.
  //
  return client +' return Primus; });'+ library.filter(Boolean).join('\n');
};

/**
 * Save the library to disk.
 *
 * @param {String} dir The location that we need to save the library.
 * @param {function} fn Optional callback, if you want an async save.
 * @api public
 */
Primus.prototype.save = function save(path, fn) {
  if (!fn) fs.writeFileSync(path, this.library(), 'utf-8');
  else fs.writeFile(path, this.library(), 'utf-8', fn);

  return this;
};

/**
 * Register a new Primus plugin.
 *
 * @param {String} name The name of the plugin.
 * @param {Object} energon The plugin that contains client and server extensions.
 * @api public
 */
Primus.prototype.use = function use(name, energon) {
  if (!name) throw new Error('Plugins should be specified with a name');
  if ('string' !== typeof name) throw new Error('Plugin names should be a string');
  if ('object' !== typeof energon) throw new Error('Plugin should be a object');

  this.ark[name] = energon;
  return this;
};

//
// Register globally, for every Primus instance. It takes the same arguments as
// the `primus.use` method.
//
Primus.use = Primus.prototype.use.bind(Primus.prototype);

/**
 * Use the given plugin `fn()`.
 *
 * @param {Function} fn
 * @return {Primus} self
 * @api public
 */
Primus.use = function use(fn) {
  var args = Array.prototype.slice.call(arguments, 1);
  args.unshift(this);

  fn.apply(this, args);
  return this;
};

/**
 * Add a createSocket interface so we can create a Server client with the
 * specified `transformer` and `parser`.
 *
 * ```js
 * var Socket = Primus.createSocket({ transformer: transformer, parser: parser })
 *   , socket = new Socket(url);
 * ```
 *
 * @param {Object} options The transformer / parser we need.
 * @returns {Socket}
 * @api public
 */
Primus.createSocket = function createSocket(options) {
  options = options || {};

  var primus = new Primus(new EventEmitter(), options);
  return primus.Socket;
};

//
// Expose the constructors of our Spark and Transformer so it can be extended by
// a third party if needed.
//
Primus.Transformer = Transformer;
Primus.Spark = Spark;

//
// Expose the module.
//
module.exports = Primus;
