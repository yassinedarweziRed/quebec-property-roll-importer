import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readUnits } from "../src/parse.js";

function tempXml(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "roll-")), "test.xml");
  writeFileSync(path, content, "utf8");
  return path;
}

const SAMPLE = `﻿<?xml version="1.0" encoding="utf-8"?>
<RL>
  <VERSION>2.9</VERSION>
  <RLM01A>01042</RLM01A>
  <RLM02A>2025</RLM02A>
  <RLUEx>
    <RL0101><RL0101x><RL0101Gx>PRINCIPAL</RL0101Gx></RL0101x><RL0101x><RL0101Gx>DU QUAI</RL0101Gx></RL0101x></RL0101>
    <RL0104><RL0104A>0174</RL0104A></RL0104>
    <RL0404A>5700</RL0404A>
  </RLUEx>
  <RLUEx><RL0404A>100</RL0404A></RLUEx>
</RL>`;

describe("readUnits", () => {
  it("streams units with the file header, and turns repeated groups into arrays", async () => {
    const results = [];
    for await (const item of readUnits(tempXml(SAMPLE))) results.push(item);

    expect(results).toHaveLength(2);
    expect(results[0].header).toEqual({ VERSION: "2.9", RLM01A: "01042", RLM02A: "2025" });
    expect(results[0].unit).toEqual({
      RL0101: { RL0101x: [{ RL0101Gx: "PRINCIPAL" }, { RL0101Gx: "DU QUAI" }] },
      RL0104: { RL0104A: "0174" },
      RL0404A: "5700",
    });
    expect(results[1].unit).toEqual({ RL0404A: "100" });
  });

  it("throws on malformed XML", async () => {
    const broken = tempXml("<RL><RLUEx><RL0404A>1</RLUEx></RL>");
    await expect(async () => {
      for await (const _ of readUnits(broken)) {
        // consume
      }
    }).rejects.toThrow();
  });
});
