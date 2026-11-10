/** Decodes a text file that may be UTF-8 or UTF-16 (older Xcode `.strings` files are UTF-16). */
export function decodeTextFile(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return utf16be(buf.subarray(2));
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  // UTF-16 without a BOM shows up as zero bytes in every other position.
  if (buf.length >= 4 && buf.length % 2 === 0) {
    if (buf[1] === 0 && buf[3] === 0 && buf[0] !== 0) return buf.toString('utf16le');
    if (buf[0] === 0 && buf[2] === 0 && buf[1] !== 0) return utf16be(buf);
  }
  return buf.toString('utf8');
}

function utf16be(buf: Buffer): string {
  const copy = Buffer.from(buf.subarray(0, buf.length - (buf.length % 2)));
  copy.swap16();
  return copy.toString('utf16le');
}
