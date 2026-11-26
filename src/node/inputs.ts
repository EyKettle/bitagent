import { realpathSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import type { SourceInput } from "../compiler/types.js";

function canonical(file: string): string {
  try { return realpathSync(file); } catch (error) {
    if (!["ENOENT","EACCES","EPERM"].includes((error as NodeJS.ErrnoException).code??"")) throw error;
    const parent = path.dirname(file);
    return parent === file ? file : path.join(canonical(parent), path.basename(file));
  }
}
export function adoptFileURL(value: unknown, directory = false): URL {
  if (!(value instanceof URL)) throw new TypeError("Source URL must be a URL");
  const url = new URL(value.href);
  if (url.protocol !== "file:" || url.username || url.password || url.search || url.hash || (!directory && url.pathname.endsWith("/")) || directory && !url.pathname.endsWith("/")) throw new TypeError("Expected an absolute clean file URL");
  const file = fileURLToPath(url);
  try { if (statSync(file).isDirectory() !== directory) throw new TypeError(directory ? "Compiler base must be a directory" : "Source entry must be a file"); }
  catch (error) { if (!["ENOENT","EACCES","EPERM"].includes((error as NodeJS.ErrnoException).code??"")) throw error; }
  return pathToFileURL(canonical(file) + (directory ? path.sep : ""));
}
export function adoptSource(input: SourceInput): SourceInput {
  if (!input || typeof input !== "object" || !["text", "file"].includes(input.kind) || Object.keys(input).some(key => !["kind", "url", ...(input.kind === "text" ? ["text"] : [])].includes(key))) throw new TypeError("Invalid source input");
  const url = adoptFileURL(input.url);
  if (input.kind === "text") { if (typeof input.text !== "string") throw new TypeError("Text source requires text"); return { kind: "text", url, text: input.text }; }
  return { kind: "file", url };
}
