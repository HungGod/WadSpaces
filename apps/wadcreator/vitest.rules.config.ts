// firestore.rules tests. They need the emulator, so they're not part of
// `npm test`: run `npm run test:rules`.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/rules/**/*.test.ts"], testTimeout: 20_000, fileParallelism: false },
});
