import { defineConfig } from "vitest/config";

// The file-sync integration tests start several real Syncthing processes. Run test files one at a time so they do not
// starve each other of CPU (their timeouts assume a calm machine).
export default defineConfig({ test: { fileParallelism: false } });
