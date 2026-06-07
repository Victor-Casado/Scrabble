import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SOURCE_ROOT = fileURLToPath(new URL(".", import.meta.url));
const PRODUCT_FILES_WITH_LOCAL_CONSTANTS = new Set(["config.ts"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "module_bindings") return [];
      return sourceFiles(fullPath);
    }
    if (!entry.name.endsWith(".ts")) return [];
    if (entry.name.endsWith(".test.ts")) return [];
    if (PRODUCT_FILES_WITH_LOCAL_CONSTANTS.has(entry.name)) return [];
    return [fullPath];
  });
}

function numericLiteralsIn(file: string): string[] {
  const sourceText = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const offenders: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.BigIntLiteral) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      offenders.push(`${file}:${line + 1}:${character + 1}: ${node.getText(sourceFile)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return offenders;
}

test("hand-written product code keeps numeric constants in config.ts", () => {
  const offenders = sourceFiles(SOURCE_ROOT).flatMap(numericLiteralsIn);

  assert.deepEqual(offenders, []);
});
