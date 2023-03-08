/*
  This is @npmcli/arborist/lib/yarn-lock.js stripped down to only what's
  needed for the yarn.lock file parser, and then with a single correction
  applied.
  NOTE: cannot apply arborist 2.8.5 changes because they require a package
  (@isaacs/string-locale-compare) that's not bundled with npm 7.24.0.
*/

const npa = require('npm-package-arg')

// sort a key/value object into a string of JSON stringified keys and vals
const sortKV = obj => Object.keys(obj)
  .sort((a, b) => a.localeCompare(b, 'en'))
  .map(k => `    ${JSON.stringify(k)} ${JSON.stringify(obj[k])}`)
  .join('\n')

const prefix =
`# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


`

const nullSymbol = Symbol('null')
class YarnLock {
  static parse (data) {
    return new YarnLock().parse(data)
  }

  constructor () {
    this.entries = null
    this.endCurrent()
  }

  endCurrent () {
    this.current = null
    this.subkey = nullSymbol
  }

  parse (data) {
    const ENTRY_START = /^[^\s].*:$/
    const SUBKEY = /^ {2}[^\s]+:$/
    const SUBVAL = /^ {4}[^\s]+ .+$/
    const METADATA = /^ {2}[^\s]+ .+$/
    this.entries = new Map()
    this.current = null
    const linere = /([^\r\n]*)\r?\n/gm
    let match
    let lineNum = 0
    if (!/\n$/.test(data)) {
      data += '\n'
    }
    while (match = linere.exec(data)) {
      const line = match[1]
      lineNum++
      if (line.charAt(0) === '#') {
        continue
      }
      if (line === '') {
        this.endCurrent()
        continue
      }
      if (ENTRY_START.test(line)) {
        this.endCurrent()
        const specs = this.splitQuoted(line.slice(0, -1), /, */)
        this.current = new YarnLockEntry(specs)
        specs.forEach(spec => this.entries.set(spec, this.current))
        continue
      }
      if (SUBKEY.test(line)) {
        this.subkey = line.slice(2, -1)
        this.current[this.subkey] = {}
        continue
      }
      if (SUBVAL.test(line) && this.current && this.current[this.subkey]) {
        const subval = this.splitQuoted(line.trimLeft(), ' ')
        if (subval.length === 2) {
          this.current[this.subkey][subval[0]] = subval[1]
          continue
        }
      }
      // any other metadata
      if (METADATA.test(line) && this.current) {
        const metadata = this.splitQuoted(line.trimLeft(), ' ')
        if (metadata.length === 2) {
          // strip off the legacy shasum hashes
          if (metadata[0] === 'resolved') {
            try {
              const parsed = npa(metadata[1])
              if (parsed.type !== 'git') {
                metadata[1] = metadata[1].replace(/#.*/, '')
              }
            } catch (err) {}
          }
          this.current[metadata[0]] = metadata[1]
          continue
        }
      }

      throw Object.assign(new Error('invalid or corrupted yarn.lock file'), {
        position: match.index,
        content: match[0],
        line: lineNum,
      })
    }
    this.endCurrent()
    return this
  }

  splitQuoted (str, delim) {
    // a,"b,c",d"e,f => ['a','"b','c"','d"e','f'] => ['a','b,c','d"e','f']
    const split = str.split(delim)
    const out = []
    let o = 0
    for (let i = 0; i < split.length; i++) {
      const chunk = split[i]
      if (/^".*"$/.test(chunk)) {
        out[o++] = chunk.trim().slice(1, -1)
      } else if (/^"/.test(chunk)) {
        let collect = chunk.trimLeft().slice(1)
        while (++i < split.length) {
          const n = split[i]
          // something that is not a slash, followed by an even number
          // of slashes then a " then end => ending on an unescaped "
          if (/[^\\](\\\\)*"$/.test(n)) {
            collect += n.trimRight().slice(0, -1)
            break
          } else {
            collect += n
          }
        }
        out[o++] = collect
      } else {
        out[o++] = chunk.trim()
      }
    }
    return out
  }

  toString () {
    return prefix + [...new Set([...this.entries.values()])]
      .map(e => e.toString())
      .sort((a, b) => a.localeCompare(b, 'en')).join('\n\n') + '\n'
  }

  static get Entry () {
    return YarnLockEntry
  }
}

const _specs = Symbol('_specs')
class YarnLockEntry {
  constructor (specs) {
    this[_specs] = new Set(specs)
    this.resolved = null
    this.version = null
    this.integrity = null
    this.dependencies = null
    this.optionalDependencies = null
  }

  toString () {
    // sort objects to the bottom, then alphabetical
    return ([...this[_specs]]
      .sort((a, b) => a.localeCompare(b, 'en'))
      .map(JSON.stringify).join(', ') +
      ':\n' +
      Object.getOwnPropertyNames(this)
        .filter(prop => this[prop] !== null)
        .sort(
          (a, b) =>
          /* istanbul ignore next - sort call order is unpredictable */
            (typeof this[a] === 'object') === (typeof this[b] === 'object')
              ? a.localeCompare(b, 'en')
              : typeof this[a] === 'object' ? 1 : -1)
        .map(prop =>
          typeof this[prop] !== 'object'
            ? `  ${JSON.stringify(prop)} ${JSON.stringify(this[prop])}\n`
            : Object.keys(this[prop]).length === 0 ? ''
            : `  ${prop}:\n` + sortKV(this[prop]) + '\n')
        .join('')).trim()
  }
}

module.exports = YarnLock
