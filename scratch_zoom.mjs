import { readFileSync, writeFileSync } from 'node:fs'
import jpeg from 'jpeg-js'
import { rotateRgba, cropRgba } from '/home/user/Ocr_crosswords/src/lib/image.ts'
import { encodePng } from '/home/user/Ocr_crosswords/scripts/png.mjs'
const [file, turns, x0, y0, x1, y1, out] = process.argv.slice(2)
const d = jpeg.decode(readFileSync(file), { useTArray: true, formatAsRGBA: true })
const img = rotateRgba({ data: d.data, width: d.width, height: d.height }, Number(turns))
const c = cropRgba(img, +x0*img.width, +y0*img.height, +x1*img.width, +y1*img.height)
writeFileSync(out, encodePng(c.width, c.height, c.data))
console.log(out, c.width+'x'+c.height)
