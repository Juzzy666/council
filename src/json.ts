/**
 * Pulling one JSON object out of an agent's reply.
 *
 * Needed for any runtime without a structured-output verb: the answer arrives
 * as text that may carry a fence, a preamble, or both. Brace matching (string-
 * and escape-aware) beats a regex here — a plan's `detail` field routinely
 * contains braces and quotes.
 */

export function extractJsonObject(text: string): unknown {
  if (!text) return undefined;
  const direct = tryParse(text.trim());
  if (direct !== undefined) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }

  // Scan for the first balanced {...} or [...] that parses.
  for (const open of ["{", "["] as const) {
    const start = text.indexOf(open);
    if (start === -1) continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          const parsed = tryParse(text.slice(start, i + 1));
          if (parsed !== undefined) return parsed;
          break;
        }
      }
    }
  }
  return undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
