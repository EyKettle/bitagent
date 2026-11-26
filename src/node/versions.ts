import { createHash } from "node:crypto";

/** Digest buckets compare adopted contents before granting version equality. */
export function versionRegistry(digest: (text: string) => string = text => createHash("sha256").update(text).digest("hex")) {
  const buckets = new Map<string, string[]>();
  return (text: string): string => {
    const hash = digest(text);
    let values = buckets.get(hash);
    if (!values) { values = []; buckets.set(hash, values); }
    let index = values.indexOf(text);
    if (index < 0) { index = values.length; values.push(text); }
    return index === 0 ? hash : `${hash}-${index}`;
  };
}
