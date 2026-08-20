import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const policies = new Map<string, Set<string>>([
  ["server/worktreeScan.ts", new Set(["./db.ts", "./settings.ts", "./worktreeScanRunner.ts"])],
  ["server/worktreeScanRunner.ts", new Set()],
]);
const forbiddenCalls = new Set(["execFileSync", "execSync", "readFileSync", "readdirSync", "spawnSync", "statSync"]);
const errors: string[] = [];

for (const [file, allowedRuntimeImports] of policies) {
  const source = ts.createSourceFile(file, readFileSync(resolve(file), "utf8"), ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const specifier = String(node.moduleSpecifier.getText(source)).slice(1, -1);
      if (!allowedRuntimeImports.has(specifier)) errors.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: runtime import ${specifier} is outside the scanner client boundary`);
    }
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : "";
      if (forbiddenCalls.has(name)) errors.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${name} can block the HTTP event loop`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("worktree scanner runtime boundary is isolated");
