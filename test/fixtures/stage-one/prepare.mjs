import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = fileURLToPath(new URL("./", import.meta.url));
const name = "stage-one-conditional";

export function prepareStageOne(root) {
  const workspace = join(root, "workspace");
  const foreign = join(root, "foreign workspace");
  const configured = join(root, "configured workspace");
  const manifest = (directory, dependencies = {}) => writeFileSync(join(directory, "package.json"), JSON.stringify({
    name: basename(directory).replaceAll(" ", "-"), type: "module", dependencies,
  }));
  const install = (directory, origin) => {
    const destination = join(directory, "node_modules", name);
    mkdirSync(destination, { recursive: true });
    cpSync(join(fixtures, "conditional"), destination, { recursive: true });
    const source = join(destination, "import.mjs");
    writeFileSync(source, readFileSync(source, "utf8").replace("@@origin@@", origin));
  };
  cpSync(join(fixtures, "workspace"), workspace, { recursive: true });
  cpSync(join(fixtures, "foreign"), foreign, { recursive: true });
  mkdirSync(configured);
  manifest(workspace);
  manifest(foreign, { [name]: "1.0.0" });
  manifest(configured, { [name]: "1.0.0" });
  install(foreign, "foreign workspace");
  install(configured, "configured project");
  return { workspace, foreign, configured };
}
