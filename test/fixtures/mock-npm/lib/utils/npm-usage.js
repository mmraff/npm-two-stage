// Npm instance passes itself to this function

module.exports = o => {
  process.emit('used', 'mock npm-usage')
  return 'Dummy npm-usage info: ' + (o.command || o.title)
}