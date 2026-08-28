import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.turbo/**",
      "mock/**",
      "plan/**",
      "docs/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    /**
     * Plain `.mjs` tooling — the gate runner and anything like it.
     *
     * These are the only files linted without type information, so `no-undef`
     * is the rule that actually runs on them, and it does not know `process`,
     * `console` or the rest of the Node surface unless it is declared. In the
     * TypeScript sources the same names come from `@types/node` and the
     * compiler checks them properly, which is why this block is scoped to
     * `.mjs` rather than turning the rule off everywhere.
     */
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        __dirname: "readonly",
      },
    },
  },
  {
    rules: {
      // Ports are contracts: unused args in interface impl stubs are expected.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
