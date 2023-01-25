/* Download extends this. Almost nothing of the actual is used by Download. */

class BaseCommand {
  constructor (npm) {
    this.npm = npm
  }
}

module.exports = BaseCommand

