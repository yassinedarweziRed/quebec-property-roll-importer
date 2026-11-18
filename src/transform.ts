// Validate + clean one raw unit into typed rows.
// Rules come from the official dictionary ("Répertoire des renseignements prescrits").
import type { RollHeader, XmlNode, XmlValue } from "./parse.js";

export class FieldError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PropertyRow {
  matricule: string;
  matricule18: string;
  borough_code: string | null;
  usage_code: string;
  file_number: string | null;
  neighborhood_unit: string | null;
  frontage: string | null; // decimals kept as text: exact, Postgres converts to numeric
  land_area: string | null;
  agricultural_zone_code: string;
  max_floors: number | null;
  construction_year: number | null;
  construction_year_estimated: boolean | null;
  floor_area: string | null;
  dwelling_count: number | null;
  market_reference_date: string;
  land_value: number | null;
  building_value: number | null;
  total_value: number;
  previous_total_value: number | null;
  is_serviced_vacant_land: boolean;
  non_residential_class: string | null;
}

export interface AddressRow {
  position: number;
  number_from: string | null;
  number_from_suffix: string | null;
  number_to: string | null;
  number_to_suffix: string | null;
  street_type_code: string | null;
  link_code: string | null;
  street_name: string;
  direction: string | null;
  apartment: string | null;
  apartment_suffix: string | null;
}

// ---- small helpers: each one reads a value and checks its format ----

function text(value: XmlValue | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function required<T>(value: T | null, field: string): T {
  if (value === null) throw new FieldError(field, "required field is missing");
  return value;
}

function integer(value: XmlValue | undefined, field: string): number | null {
  const v = text(value);
  if (v === null) return null;
  if (!/^\d+$/.test(v)) throw new FieldError(field, `not an integer: "${v}"`);
  return Number(v);
}

function decimal(value: XmlValue | undefined, field: string): string | null {
  const v = text(value);
  if (v === null) return null;
  if (!/^\d+(\.\d+)?$/.test(v)) throw new FieldError(field, `not a decimal number: "${v}"`);
  return v;
}

function date(value: XmlValue | undefined, field: string): string | null {
  const v = text(value);
  if (v === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw new FieldError(field, `not a date (YYYY-MM-DD): "${v}"`);
  }
  return v;
}

function oneOf(value: XmlValue | undefined, field: string, allowed: string[]): string | null {
  const v = text(value);
  if (v !== null && !allowed.includes(v)) throw new FieldError(field, `unexpected value: "${v}"`);
  return v;
}

function inRange(n: number | null, field: string, min: number, max: number): number | null {
  if (n !== null && (n < min || n > max)) throw new FieldError(field, `out of range ${min}-${max}: ${n}`);
  return n;
}

function group(value: XmlValue | undefined): XmlNode {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// ---- file level ----

export interface FileInfo {
  municipalityCode: string;
  rollYear: number;
  xmlVersion: string | null;
}

/** Checks the file header. Throws if it is not usable: the whole file is then rejected. */
export function checkHeader(header: RollHeader): FileInfo {
  const code = required(text(header.RLM01A), "RLM01A");
  if (!/^(\d{5}|NR\d{3})$/.test(code)) throw new FieldError("RLM01A", `bad municipality code: "${code}"`);
  const year = inRange(integer(header.RLM02A, "RLM02A"), "RLM02A", 2007, 2050);
  return { municipalityCode: code, rollYear: required(year, "RLM02A"), xmlVersion: text(header.VERSION) };
}

// ---- unit level ----

/** The 6 matricule parts RL0104A..F. A, B, C are required; D, E, F are "" when absent. */
function matriculeParts(unit: XmlNode): string[] {
  const m = group(unit.RL0104);
  const parts = ["RL0104A", "RL0104B", "RL0104C"].map((tag) => required(text(m[tag]), `RL0104.${tag}`));
  for (const tag of ["RL0104D", "RL0104E", "RL0104F"]) parts.push(text(m[tag]) ?? "");
  return parts;
}

/** Matricule = RL0104A-B-C-D-E-F. Empty trailing parts are removed: "0174-87-0100". */
export function buildMatricule(unit: XmlNode): string {
  return matriculeParts(unit).join("-").replace(/-+$/, "");
}

/** 18-digit matricule used by the geo file: parts joined, empty D/E/F filled with zeros. */
export function buildMatricule18(unit: XmlNode): string {
  const [a, b, c, d, e, f] = matriculeParts(unit);
  return a + b + c + (d || "0") + (e || "000") + (f || "0000");
}

/** Throws FieldError if the unit breaks a rule: the unit is then rejected and logged. */
export function transformUnit(unit: XmlNode): { property: PropertyRow; addresses: AddressRow[] } {
  const estimatedFlag = oneOf(unit.RL0307B, "RL0307B", ["E", "R"]); // E = estimated, R = real
  const property: PropertyRow = {
    matricule: buildMatricule(unit),
    matricule18: buildMatricule18(unit),
    borough_code: text(unit.RL0102A),
    usage_code: required(text(unit.RL0105A), "RL0105A"),
    file_number: text(unit.RL0106A),
    neighborhood_unit: text(unit.RL0107A),
    frontage: decimal(unit.RL0301A, "RL0301A"),
    land_area: decimal(unit.RL0302A, "RL0302A"),
    agricultural_zone_code: required(oneOf(unit.RL0303A, "RL0303A", ["0", "1", "2"]), "RL0303A"),
    max_floors: integer(unit.RL0306A, "RL0306A"),
    construction_year: inRange(integer(unit.RL0307A, "RL0307A"), "RL0307A", 1600, 2050),
    construction_year_estimated: estimatedFlag === null ? null : estimatedFlag === "E",
    floor_area: decimal(unit.RL0308A, "RL0308A"),
    dwelling_count: integer(unit.RL0311A, "RL0311A"),
    market_reference_date: required(date(unit.RL0401A, "RL0401A"), "RL0401A"),
    land_value: integer(unit.RL0402A, "RL0402A"),
    building_value: integer(unit.RL0403A, "RL0403A"),
    total_value: required(integer(unit.RL0404A, "RL0404A"), "RL0404A"),
    previous_total_value: integer(unit.RL0405A, "RL0405A"),
    is_serviced_vacant_land: required(oneOf(unit.RL0501A, "RL0501A", ["0", "1"]), "RL0501A") === "1",
    non_residential_class: text(unit.RL0502A),
  };

  const rawAddresses = group(unit.RL0101).RL0101x;
  const addresses = (Array.isArray(rawAddresses) ? rawAddresses : []).map((a, i) => ({
    position: i + 1,
    number_from: text(a.RL0101Ax),
    number_from_suffix: text(a.RL0101Bx),
    number_to: text(a.RL0101Cx),
    number_to_suffix: text(a.RL0101Dx),
    street_type_code: text(a.RL0101Ex),
    link_code: text(a.RL0101Fx),
    street_name: required(text(a.RL0101Gx), "RL0101Gx"),
    direction: text(a.RL0101Hx),
    apartment: text(a.RL0101Ix),
    apartment_suffix: text(a.RL0101Jx),
  }));

  return { property, addresses };
}
