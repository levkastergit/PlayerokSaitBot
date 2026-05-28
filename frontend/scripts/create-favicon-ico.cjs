const fs = require('fs')
const path = require('path')

const size = 32
const pixels = []

for (let y = size - 1; y >= 0; y--) {
  for (let x = 0; x < size; x++) {
    let b = 0x2a
    let g = 0x17
    let r = 0x0f
    const a = 255

    if (x >= 8 && x <= 23 && y >= 12 && y <= 25) {
      b = 0x69
      g = 0x96
      r = 0x05
    }
    if (x >= 11 && x <= 15 && y >= 16 && y <= 20) {
      b = g = r = 0x0f
    }
    if (x >= 18 && x <= 22 && y >= 16 && y <= 20) {
      b = g = r = 0x0f
    }
    if (x >= 13 && x <= 19 && y >= 22 && y <= 23) {
      b = g = r = 0x0f
    }
    if (x >= 14 && x <= 18 && y >= 4 && y <= 8) {
      b = 0x5e
      g = 0xc5
      r = 0x22
    }
    if (x >= 15 && x <= 17 && y >= 2 && y <= 4) {
      b = 0x5e
      g = 0xc5
      r = 0x22
    }

    pixels.push(b, g, r, a)
  }
}

const andMask = Buffer.alloc(size * 4, 0)
const header = Buffer.alloc(40)
header.writeUInt32LE(40, 0)
header.writeInt32LE(size, 4)
header.writeInt32LE(size * 2, 8)
header.writeUInt16LE(1, 12)
header.writeUInt16LE(32, 14)
header.writeUInt32LE(pixels.length, 20)

const imageData = Buffer.concat([header, Buffer.from(pixels), andMask])
const dir = Buffer.from([0, 0, 1, 0, 1, 0])
const entry = Buffer.alloc(16)
entry[0] = size
entry[1] = size
entry.writeUInt16LE(1, 4)
entry.writeUInt16LE(32, 6)
entry.writeUInt32LE(imageData.length, 8)
entry.writeUInt32LE(22, 12)

const ico = Buffer.concat([dir, entry, imageData])
const publicDir = path.join(__dirname, '..', 'public')
fs.mkdirSync(publicDir, { recursive: true })
fs.writeFileSync(path.join(publicDir, 'favicon.ico'), ico)
