import { describe, expect, it } from "vitest";
import { readPoint } from "../src/gpkg.js";

// Builds a GeoPackage geometry blob: "GP" header + optional envelope + WKB MultiPoint with one point.
function multiPointBlob(x: number, y: number, withEnvelope: boolean): Buffer {
  const header = Buffer.from([0x47, 0x50, 0, withEnvelope ? 0b011 : 0b001, 0xad, 0x10, 0, 0]); // srs 4269
  const envelope = Buffer.alloc(withEnvelope ? 32 : 0);
  if (withEnvelope) [x, x, y, y].forEach((v, i) => envelope.writeDoubleLE(v, i * 8));
  const wkb = Buffer.alloc(30);
  wkb.writeUInt8(1, 0); // little endian
  wkb.writeUInt32LE(4, 1); // MultiPoint
  wkb.writeUInt32LE(1, 5); // 1 point
  wkb.writeUInt8(1, 9);
  wkb.writeUInt32LE(1, 10); // Point
  wkb.writeDoubleLE(x, 14);
  wkb.writeDoubleLE(y, 22);
  return Buffer.concat([header, envelope, wkb]);
}

describe("readPoint", () => {
  it("reads the point of a MultiPoint, with or without envelope", () => {
    expect(readPoint(multiPointBlob(-61.539796, 47.611532, true))).toEqual([-61.539796, 47.611532]);
    expect(readPoint(multiPointBlob(-71.9, 45.4, false))).toEqual([-71.9, 45.4]);
  });

  it("rejects data that is not a GeoPackage geometry", () => {
    expect(() => readPoint(Buffer.from("not a geometry"))).toThrow();
  });
});
