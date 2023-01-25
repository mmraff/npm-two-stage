const tap = require('tap')
const npa = require('npm-package-arg')
const gtk = require('../src/download/git-tracker-keys')

tap.test('should throw a SyntaxError if given no argument', t => {
  t.throws(() => gtk(), SyntaxError)
  t.end()
})

tap.test('should throw a TypeError if not given an object, or one with no `type` field', t => {
  const badArgs = [ undefined, null, true, 42, 'hello', [], {}, function(){} ]
  for (let i =0; i < badArgs.length; ++i)
    t.throws(() => gtk(badArgs[i]), TypeError)
  t.end()
})

tap.test('should throw a TypeError if object `type` field value is not "git"', t => {
  const npaWrongTypes = [
    'version', 'range', 'tag', 'remote', 'file', 'directory', 'alias'
  ]
  for (let i =0; i < npaWrongTypes.length; ++i)
    t.throws(() => gtk({ type: npaWrongTypes[i] }), TypeError)
  t.end()
})

tap.test('should throw a TypeError if object `rawSpec` field value is not a valid URL', t => {
  t.throws(() => gtk({type: 'git', rawSpec: '!@#$%^&*'}), TypeError)
  t.end()
})

tap.test('should return an object with nonempty fields `repo` and `spec` on valid input based on hosted git URL with hash', t => {
  const result = gtk(npa('git://github.com/user/project#abcdef'))
  t.hasProps(result, ['repo', 'spec'])
  t.type(result.repo, 'string')
  t.notSame(result.repo.trim(), '')
  t.type(result.spec, 'string')
  t.notSame(result.spec.trim(), '')
  t.end()
})

tap.test('should return an object with empty field `spec` on valid input based on hosted git URL with no hash', t => {
  const result = gtk(npa('git://github.com/user/project'))
  t.hasProps(result, ['repo', 'spec'])
  t.type(result.repo, 'string')
  t.notSame(result.repo.trim(), '')
  t.type(result.spec, 'string')
  t.equal(result.spec, '')
  t.end()
})

tap.test('should return an object with nonempty fields `repo` and `spec` on valid input based on unhosted git URL with hash', t => {
  const result = gtk(npa('git://git-host.com/user/project#abcdef'))
  t.hasProps(result, ['repo', 'spec'])
  t.type(result.repo, 'string')
  t.notSame(result.repo.trim(), '')
  t.type(result.spec, 'string')
  t.notSame(result.spec.trim(), '')
  t.end()
})

