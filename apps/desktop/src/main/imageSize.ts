import { type FileHandle, open } from "node:fs/promises"
import type { ImageSize } from "../shared/api"

/** Pixel size from the file header (PNG, GIF, WebP, JPEG) without decoding the image; undefined for anything else. */
export async function imageSize(abs: string): Promise<ImageSize | undefined> {
  let fh: FileHandle
  try {
    fh = await open(abs, "r")
  } catch {
    return undefined
  }
  try {
    const head = Buffer.alloc(32)
    const { bytesRead } = await fh.read(head, 0, 32, 0)
    if (bytesRead < 30) return undefined
    if (head.readUInt32BE(0) === 0x89504e47) return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) }
    if (head.toString("ascii", 0, 4) === "GIF8") return { w: head.readUInt16LE(6), h: head.readUInt16LE(8) }
    if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") {
      switch (head.toString("ascii", 12, 16)) {
        case "VP8X":
          return { w: 1 + head.readUIntLE(24, 3), h: 1 + head.readUIntLE(27, 3) }
        case "VP8 ":
          return { w: head.readUInt16LE(26) & 0x3fff, h: head.readUInt16LE(28) & 0x3fff }
        case "VP8L": {
          const bits = head.readUInt32LE(21)
          return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >>> 14) & 0x3fff) }
        }
      }
      return undefined
    }
    if (head[0] === 0xff && head[1] === 0xd8) return await jpegSize(fh)
    return undefined
  } catch {
    return undefined
  } finally {
    await fh.close()
  }
}

/** Walk the JPEG segments to the first start-of-frame marker, which holds the size. */
async function jpegSize(fh: FileHandle): Promise<ImageSize | undefined> {
  const b = Buffer.alloc(9)
  let pos = 2
  for (let i = 0; i < 100; i++) {
    const { bytesRead } = await fh.read(b, 0, 9, pos)
    if (bytesRead < 4 || b[0] !== 0xff) return undefined
    const marker = b[1]!
    if (marker === 0xff) {
      pos += 1
      continue
    }
    // C4 (Huffman tables), C8 and CC are not frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return bytesRead < 9 ? undefined : { w: b.readUInt16BE(7), h: b.readUInt16BE(5) }
    }
    pos += 2 + b.readUInt16BE(2)
  }
  return undefined
}
