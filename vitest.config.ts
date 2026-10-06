import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 180_000,
		hookTimeout: 180_000,
		// The executor and coordinator tests spawn real processes (the Pi
		// coder, a validator run) over shared socket directories; they are
		// not parallel-safe.
		fileParallelism: false,
	},
});
