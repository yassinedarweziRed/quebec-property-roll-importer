import { describe, expect, it } from "vitest";
import type { XmlNode } from "../src/parse.js";
import { checkHeader, FieldError, transformUnit } from "../src/transform.js";

// A minimal valid unit, shaped like the output of the parser.
function validUnit(): XmlNode {
  return {
    RL0101: { RL0101x: [{ RL0101Ax: "50", RL0101Ex: "CH", RL0101Gx: "PRINCIPAL" }] },
    RL0104: { RL0104A: "0174", RL0104B: "87", RL0104C: "0100" },
    RL0105A: "1000",
    RL0303A: "0",
    RL0307A: "1975",
    RL0307B: "R",
    RL0302A: "53820.00",
    RL0401A: "2024-07-01",
    RL0402A: "5700",
    RL0404A: "5700",
    RL0501A: "0",
  };
}

function fieldOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof FieldError) return err.field;
    throw err;
  }
  return undefined;
}

describe("transformUnit", () => {
  it("cleans a valid unit into typed values", () => {
    const { property, addresses } = transformUnit(validUnit());
    expect(property.matricule).toBe("0174-87-0100");
    expect(property.total_value).toBe(5700);
    expect(property.land_area).toBe("53820.00");
    expect(property.construction_year).toBe(1975);
    expect(property.construction_year_estimated).toBe(false); // R = real
    expect(property.is_serviced_vacant_land).toBe(false);
    expect(property.market_reference_date).toBe("2024-07-01");
    expect(addresses).toEqual([
      expect.objectContaining({ position: 1, number_from: "50", street_type_code: "CH", street_name: "PRINCIPAL" }),
    ]);
  });

  it("turns missing optional fields into null, not 0", () => {
    const { property } = transformUnit(validUnit());
    expect(property.building_value).toBeNull();
    expect(property.dwelling_count).toBeNull();
  });

  it("keeps optional matricule parts and removes empty trailing ones", () => {
    const unit = validUnit();
    unit.RL0104 = { RL0104A: "0174", RL0104B: "87", RL0104C: "0100", RL0104E: "001" };
    expect(transformUnit(unit).property.matricule).toBe("0174-87-0100--001");
  });
  it("rejects a unit with a missing required field", () => {
    const unit = validUnit();
    delete unit.RL0404A;
    expect(fieldOf(() => transformUnit(unit))).toBe("RL0404A");
  });

  it("rejects bad formats and out-of-range values", () => {
    expect(fieldOf(() => transformUnit({ ...validUnit(), RL0402A: "abc" }))).toBe("RL0402A");
    expect(fieldOf(() => transformUnit({ ...validUnit(), RL0401A: "2024-13-45" }))).toBe("RL0401A");
    expect(fieldOf(() => transformUnit({ ...validUnit(), RL0307A: "1200" }))).toBe("RL0307A");
    expect(fieldOf(() => transformUnit({ ...validUnit(), RL0303A: "7" }))).toBe("RL0303A");
  });
});

describe("checkHeader", () => {
  it("reads the municipality code and the roll year", () => {
    expect(checkHeader({ VERSION: "2.9", RLM01A: "01042", RLM02A: "2025" })).toEqual({
      municipalityCode: "01042",
      rollYear: 2025,
      xmlVersion: "2.9",
    });
  });

  it("rejects a file without a valid municipality code or year", () => {
    expect(fieldOf(() => checkHeader({ RLM02A: "2025" }))).toBe("RLM01A");
    expect(fieldOf(() => checkHeader({ RLM01A: "ABC", RLM02A: "2025" }))).toBe("RLM01A");
    expect(fieldOf(() => checkHeader({ RLM01A: "01042" }))).toBe("RLM02A");
  });
});
