module.exports = () => {
  const min = 'A'.charCodeAt(0)
  const max = 'f'.charCodeAt(0)
  const zeroCharVal = '0'.charCodeAt(0)
  const seq = []
  for (let i = 0; i < 40; ++i) {
    let v = Math.floor(Math.random() * (max - min + 1)) + min
    if (v > min + 5) {
      if (v < max - 5) v =v % 10 + zeroCharVal
    }
    else v += 32 // distance between 'A' and 'a'
    seq.push(String.fromCharCode(v))
  }
  return seq.join('')
}
