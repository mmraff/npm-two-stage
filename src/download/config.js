const settings = {
  dlTracker: null,
  opts: null,
  cache: null,
  log: null,
}

function get(prop) {
  return settings[prop]
}

function set(prop, value) {
  if (Object.isFrozen(settings))
    throw new Error("Attempt to change config when it is frozen")
  if (prop in settings)
    settings[prop] = value
  else
    throw new Error("Attempt to set unrecognized config property")
}

function freeze() {
  if (Object.isFrozen(settings))
    throw new Error("Attempt to freeze config when it is already frozen")
  Object.freeze(settings)
}

module.exports = { get, set, freeze }
