import { resolveExtensionEntries } from "../lib/resolver.js";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { readFile } from "node:fs/promises";
import { PiExtensionRuntime } from "../lib/runtime.js";

const extPath = process.argv[2] || "/Users/sab-mini/repos/pi-subagents";
const cwd = "/Users/sab-mini";
console.log("PROBING", extPath);
const pkg = JSON.parse(await readFile(join(extPath, "package.json"), "utf8"));
console.log("pkg:", pkg.name + "@" + pkg.version);

const entries = await resolveExtensionEntries([extPath], { cwd, allowLocalPaths: true });
console.log("entries:", JSON.stringify(entries, null, 2));

const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const loaderUrl = pathToFileURL(join(dirname(piEntry), "core/extensions/loader.js")).href;
console.log("loader:", loaderUrl);
const loader = await import(loaderUrl);
const result = await loader.loadExtensions(entries, cwd, createEventBus());
console.log("errors_count:", result.errors.length);
for (const [fi, err] of result.errors.entries()) {
  console.log("--- error", fi);
  const payload = { path: err.path, message: err.message, stack: err.stack };
  if (err.error) {
    payload.error = {
      name: err.error.name,
      message: err.error.message,
      stack: err.error.stack,
      code: err.error.code,
      cause: err.error.cause ? String(err.error.cause) : undefined,
    };
  }
  console.log("full:", JSON.stringify(payload, null, 2));
  console.log(inspect(err, { depth: 10, colors: false }));
}
console.log("extensions_loaded:", result.extensions.length);
if (result.errors.length === 0) {
  const runtime = await PiExtensionRuntime.fromPaths(entries, { cwd, projectTrusted: false });
  await runtime.start("startup");
  const tools = runtime.tools().map((t) => ({
    name: t.name,
    description: String(t.description || "").slice(0, 200),
  }));
  console.log("tools_count:", tools.length);
  console.log("tools:", JSON.stringify(tools, null, 2));
  await runtime.shutdown();
  console.log("REGISTRATION_PASS");
} else {
  console.error("LOAD_FAILED");
  process.exitCode = 1;
}
