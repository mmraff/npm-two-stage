const expect = require('chai').expect
const semver = require('semver')

const C = require('../lib/constants')

describe('constants module', function() {
  it('should export a targetVersion property that has a semver 2.0 string value', function() {
    expect(C).to.have.a.property('targetVersion').that.is.a('string')
    expect(semver.valid(C.targetVersion)).to.equal(C.targetVersion)
  })

  const targetsFields = [ 'CHANGED_FILES', 'ADDED_FILES', 'ADDED_DIRS' ]

  it('should export a targets object with fields CHANGED_FILES, ADDED_FILES, and ADDED_DIRS', function() {
    expect(C).to.have.a.property('targets').that.is.an('object')
    expect(C.targets).to.have.all.keys(targetsFields)
  })

  it('should have an array of nothing but non-empty strings assigned to each targets field', function() {
    for (let f = 0; f < targetsFields.length; ++f) {
      const field = targetsFields[f]
      expect(C.targets[field]).to.be.an('array')
      const list = C.targets[field]
      for (let i = 0; i < list.length; ++i)
        expect(list[i]).to.be.a('string').that.is.not.empty
    }
  })

  it('should export a backupFlag property that has a nonempty string value', function() {
    expect(C).to.have.a.property('backupFlag').that.is.a('string').that.is.not.empty
  })

  const errorCodesFields = [
    'BAD_PROJECT', 'NO_NPM', 'WRONG_NPM_VER', 'BAD_NPM_INST', 'LEFTOVERS', 'FS_ACTION_FAIL'
  ]

  it('should export an errorCodes object with fields ' + errorCodesFields.join(', '), function() {
    expect(C).to.have.a.property('errorCodes').that.is.an('object')
    expect(C.errorCodes).to.have.all.keys(errorCodesFields)
  })

  it('should have a unique non-zero numeric value assigned to each field of errorCodes', function() {
    const valuesSeen = new Set()
    for (let i = 0; i < errorCodesFields.length; ++i) {
      const field = errorCodesFields[i]
      const val = C.errorCodes[field]
      expect(val).to.be.a('number').that.does.not.equal(0)
      expect(valuesSeen.has(val)).to.be.false
      valuesSeen.add(val)
    }
  })

  it('should make all exported properties immutable', function() {
    const originalTargetVersion = C.targetVersion
    const originalTargets = {}
    for (let f = 0; f < targetsFields.length; ++f) {
      const field = targetsFields[f]
      originalTargets[field] = Object.assign([], C.targets[field])
    }
    const originalBackupFlag = C.backupFlag
    const originalErrorCodes = Object.assign({}, C.errorCodes)

    // Try to change values in different ways
    C.targetVersion = '999.999.999'
    expect(C.targetVersion).to.equal(originalTargetVersion)

    C.targets = "404 Error"
    expect(C.targets).to.deep.equal(originalTargets)
    for (let f = 0; f < targetsFields.length; ++f) {
      const field = targetsFields[f]
      const list = C.targets[field]
      C.targets[field] = null
      expect(C.targets[field]).to.not.be.null
      if (list.length < 1) continue // just in case
      list[0] = 'OWNED'
      list[list.length - 1] = 'OOPS'
      expect(function(){ C.targets[field].push(999) }).to.throw(/not extensible/)
    }
    expect(C.targets).to.deep.equal(originalTargets)

    C.backupFlag = function(){}
    expect(C.backupFlag).to.equal(originalBackupFlag)

    C.errorCodes = new Date()
    expect(C.errorCodes).to.deep.equal(originalErrorCodes)
    for (let field in C.errorCodes)
      C.errorCodes[field] = 0
    C.errorCodes.NEVER_HEARD_OF_THIS_ONE = 42
    expect(C.errorCodes).to.deep.equal(originalErrorCodes)
  })
})
