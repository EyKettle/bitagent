import { fileURLToPath } from "node:url";
import { compileContractProject } from "../dist/node/contracts.js";

// tsc bootstraps the compiler; the public compiler then builds every contract,
// including official functions, exactly as it builds an external user package.
compileContractProject(fileURLToPath(new URL("../tsconfig.build.json", import.meta.url)));
