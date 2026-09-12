import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PublicApiCatalogManager } from "../src/core/api/publicApiCatalog.ts";

const markdown = `### Information
API | Description | Auth | HTTPS | CORS |
|---|---|---|---|---|
| [Open Data](https://example.com/open) | Public data lookup | No | Yes | Yes |
| [Needs Key](https://example.com/key) | Authenticated data lookup | \`apiKey\` | Yes | Unknown |
| [Insecure](http://example.com) | Should be skipped | No | No | No |
`;

test("imports public-apis Markdown as bounded catalog metadata", () => {
  const storagePath = path.join(os.tmpdir(), `sara-public-api-source-${Date.now()}.json`);
  const manager = new PublicApiCatalogManager({ storagePath });
  const summary = manager.importPublicApisMarkdown(markdown, { maxEntries: 2, source: "test-source" });

  assert.equal(summary.discovered, 2);
  assert.equal(summary.imported, 2);
  assert.equal(summary.skipped, 0);
  assert.equal(manager.getById("open_data")?.risk_level, "READ_ONLY");
  assert.equal(manager.getById("needs_key")?.user_approval_required, true);
  assert.equal(manager.getById("open_data")?.source_repository, "test-source");
  assert.equal(manager.getById("insecure"), undefined);
  fs.rmSync(storagePath, { force: true });
});
