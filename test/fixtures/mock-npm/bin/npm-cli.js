#!/usr/bin/env node

let config
try { config = require('./cli-config.json') }
catch (err) {}

if (config) {
  if ('output' in config) console.log(config.output)
  if ('stderr' in config) console.error(config.stderr)
  if ('error' in config) throw new Error(config.error)
  else if (config.exit) process.exit(config.exit)
}
