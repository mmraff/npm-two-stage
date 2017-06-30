// Based on cache/caching-client.js.
// For the tarball downloading phase, the npm cache is irrelevant.
// This module ensures that we skip the cache when querying and
// fetching from the repository.

module.exports = VanillaRegistryClient

var inherits = require('util').inherits
var log = require('npmlog')
var npm = require('../npm.js')
var RegistryClient = require('npm-registry-client')

function VanillaRegistryClient (config)
{
  RegistryClient.call(this, adaptConfig(config))
}
inherits(VanillaRegistryClient, RegistryClient)

function adaptConfig (config)
{
  return {
    proxy: {
      http: config.get('proxy'),
      https: config.get('https-proxy'),
      localAddress: config.get('local-address')
    },
    ssl: {
      certificate: config.get('cert'),
      key: config.get('key'),
      ca: config.get('ca'),
      strict: config.get('strict-ssl')
    },
    retry: {
      retries: config.get('fetch-retries'),
      factor: config.get('fetch-retry-factor'),
      minTimeout: config.get('fetch-retry-mintimeout'),
      maxTimeout: config.get('fetch-retry-maxtimeout')
    },
    userAgent: config.get('user-agent'),
    log: log,
    defaultTag: config.get('tag'),
    couchToken: config.get('_token'),
    maxSockets: config.get('maxsockets'),
    scope: npm.projectScope
  }
}
