// GeoPackage geometry decoding (spec: https://www.geopackage.org/spec/#gpb_format).
// A geometry is stored as: "GP" header (8 bytes) + optional envelope + standard WKB.

const ENVELOPE_SIZES = [0, 32, 48, 48, 64]; // bytes, by envelope type (flags bits 1-3)

/** Returns [longitude, latitude] of a Point, or of the first point of a MultiPoint. */
export function readPoint(blob: Buffer): [number, number] {
  if (blob.toString("ascii", 0, 2) !== "GP") throw new Error("not a GeoPackage geometry");
  const flags = blob[3];
  if (flags & 0b10000) throw new Error("empty geometry");
  let offset = 8 + ENVELOPE_SIZES[(flags >> 1) & 0b111];

  // WKB: byte order (1 = little endian), geometry type, then coordinates
  let littleEndian = blob[offset] === 1;
  const type = littleEndian ? blob.readUInt32LE(offset + 1) : blob.readUInt32BE(offset + 1);
  if (type % 1000 === 4) {
    // MultiPoint: skip its header (1 + 4) and point count (4) to reach the first Point
    offset += 9;
    littleEndian = blob[offset] === 1;
  } else if (type % 1000 !== 1) {
    throw new Error(`unsupported geometry type ${type}`);
  }
  const x = littleEndian ? blob.readDoubleLE(offset + 5) : blob.readDoubleBE(offset + 5);
  const y = littleEndian ? blob.readDoubleLE(offset + 13) : blob.readDoubleBE(offset + 13);
  return [x, y];
}
