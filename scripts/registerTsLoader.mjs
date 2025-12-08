/* eslint-env node */
import { readFile } from "node:fs/promises";
import ts from "typescript";

const compilerOptions = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2020,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  esModuleInterop: true,
  resolveJsonModule: true,
  sourceMap: false,
};

export async function resolve(specifier, context, defaultResolve) {
  if (specifier.endsWith(".ts") || specifier.endsWith(".tsx")) {
    const resolved = await defaultResolve(specifier, context, defaultResolve);
    return { url: resolved.url, format: "module", shortCircuit: true };
  }

  return defaultResolve(specifier, context, defaultResolve);
}

export async function load(url, context, defaultLoad) {
  if (url.endsWith(".ts") || url.endsWith(".tsx")) {
    const source = await readFile(new globalThis.URL(url), "utf8");
    const transpiled = ts.transpileModule(source, { compilerOptions });

    return {
      format: "module",
      source: transpiled.outputText,
      shortCircuit: true,
    };
  }

  return defaultLoad(url, context, defaultLoad);
}
