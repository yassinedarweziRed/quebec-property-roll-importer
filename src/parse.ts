import { createReadStream } from "node:fs";
import { SaxesParser } from "saxes";

// One property unit (<RLUEx>) as a plain object.
// Leaf tags become strings. Repeated groups (tags ending in "x" that have children,
// e.g. RL0101x = one address) become arrays, because a unit can have several.
export type XmlValue = string | XmlNode | XmlNode[];
export interface XmlNode {
  [tag: string]: XmlValue;
}

// File-level fields that appear once, before the units.
export interface RollHeader {
  VERSION?: string;
  RLM01A?: string; // municipality code
  RLM02A?: string; // roll year
}

/**
 * Streams a roll XML file and yields one unit at a time.
 * Memory stays low: only the current unit is kept, never the whole file.
 * Throws if the XML is malformed.
 */
export async function* readUnits(
  filePath: string,
): AsyncGenerator<{ header: RollHeader; unit: XmlNode }> {
  const parser = new SaxesParser();
  const header: RollHeader = {};
  const ready: XmlNode[] = [];
  const stack: { name: string; node: XmlNode; text: string }[] = [];

  parser.on("opentag", (tag) => stack.push({ name: tag.name, node: {}, text: "" }));
  parser.on("text", (text) => {
    if (stack.length) stack[stack.length - 1].text += text;
  });
  parser.on("closetag", () => {
    const el = stack.pop()!;
    const parent = stack[stack.length - 1];
    if (!parent) return; // closing the root <RL>

    if (el.name === "RLUEx") {
      ready.push(el.node);
      return;
    }
    const hasChildren = Object.keys(el.node).length > 0;
    if (parent.name === "RL") {
      header[el.name as keyof RollHeader] = el.text.trim();
    } else if (hasChildren && el.name.endsWith("x")) {
      ((parent.node[el.name] ??= []) as XmlNode[]).push(el.node);
    } else {
      parent.node[el.name] = hasChildren ? el.node : el.text.trim();
    }
  });

  let first = true;
  for await (const chunk of createReadStream(filePath, { encoding: "utf8" })) {
    // The files start with a BOM (invisible marker) that the XML parser rejects.
    parser.write(first ? (chunk as string).replace(/^﻿/, "") : chunk);
    first = false;
    for (const unit of ready.splice(0)) yield { header, unit };
  }
  parser.close();
  for (const unit of ready.splice(0)) yield { header, unit };
}
