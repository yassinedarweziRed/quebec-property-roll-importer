// The official index CSV lists every municipality's roll file: "code géographique,nom du territoire,lien".

export interface IndexEntry {
  code: string; // 5 characters, e.g. "01042" or "NR020"
  name: string;
  url: string;
}

export function indexUrl(year: number): string {
  return `https://donneesouvertes.affmunqc.net/role/indexRole${year}.csv`;
}

/** Codes are written without leading zeros in the CSV (1042), but with them in the XML (01042). */
export function normalizeCode(code: string): string {
  return /^\d+$/.test(code) ? code.padStart(5, "0") : code;
}

export function parseIndex(csv: string): Map<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>();
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const [rawCode, name, url] = line.split(",");
    if (!rawCode || !name) continue;
    const code = normalizeCode(rawCode);
    entries.set(code, { code, name: name.trim(), url: (url ?? "").trim() });
  }
  return entries;
}
