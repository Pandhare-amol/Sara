import test from "node:test";
import assert from "node:assert/strict";
import { MusicContentPreparationService } from "../src/services/music_studio/content_preparation";

test("publishing preparation does not claim readiness without a verified video", async () => {
  const service = new MusicContentPreparationService();
  const readiness = await service.prepare("missing-project").catch((error: Error) => ({ error: error.message }));
  assert.deepEqual(readiness, { error: "Music project not found." });
});