import { describe, expect, it } from "vitest";
import { normalizeCode, parseIndex } from "../src/indexCsv.js";

const CSV = `code géographique,nom du territoire,lien
1042,Grosse-Île,https://donneesouvertes.affmunqc.net/role/RL01042_2026.xml
43027,Sherbrooke,https://donneesouvertes.affmunqc.net/role/RL43027_2026.xml\r
NR020,Territoire non organisé,https://donneesouvertes.affmunqc.net/role/RLNR020_2026.xml
`;

describe("parseIndex", () => {
  it("reads code, name and link, with codes padded to 5 characters", () => {
    const index = parseIndex(CSV);
    expect(index.size).toBe(3);
    expect(index.get("01042")).toEqual({
      code: "01042",
      name: "Grosse-Île",
      url: "https://donneesouvertes.affmunqc.net/role/RL01042_2026.xml",
    });
    expect(index.get("43027")?.url).toBe("https://donneesouvertes.affmunqc.net/role/RL43027_2026.xml");
    expect(index.get("NR020")?.name).toBe("Territoire non organisé");
  });

  it("normalizes codes typed by a user", () => {
    expect(normalizeCode("1042")).toBe("01042");
    expect(normalizeCode("01042")).toBe("01042");
    expect(normalizeCode("NR020")).toBe("NR020");
  });
});
