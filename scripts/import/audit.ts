import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { APPROVED_WORKBOOK_FILENAME, previewApprovedWorkbook } from "../../src/lib/import/approved-workbook";

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const outputIndex = args.indexOf("--out");
  const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (outputIndex >= 0 && !outputPath) throw new Error("--out requires a path");
  const explicitInput = args.find((arg, index) => !arg.startsWith("--") && index !== outputIndex + 1);
  const inputPath = resolve(explicitInput ?? `C:/Users/User/Downloads/${APPROVED_WORKBOOK_FILENAME}`);
  const preview = await previewApprovedWorkbook(await readFile(inputPath), basename(inputPath));
  if (outputPath) await writeFile(resolve(outputPath), `${JSON.stringify(preview.payload, null, 2)}\n`, { flag: "wx" });
  if (json) {
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(preview.audit, null, 2)}\n`);
  for (const item of preview.payload.review_items) {
    process.stdout.write(`REVIEW ${item.kind} ${item.source_sheet}!${item.source_row}: ${item.details}\n`);
  }
  process.stdout.write("No database write performed. Stage only after explicit workflow authorization; activation remains blocked while critical reviews are open.\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
