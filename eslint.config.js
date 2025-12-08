// ESLint 9 flat config
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierPlugin from "eslint-plugin-prettier";
import eslintConfigPrettier from "eslint-config-prettier";

/**
 * Flat config array
 * - ignores replaces .eslintignore
 * - includes TypeScript recommended rules and Prettier integration
 */
export default [
  {
    // Replaces .eslintignore
    ignores: [
      "dist/**",
      "node_modules/**",
      ".wrangler/**",
      "**/.wrangler/**",
      "workers/voice-chat/node_modules/**",
      "pnpm-lock.yaml",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    name: "project:typescript+prettier",
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        project: false,
      },
    },
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      // Disable ESLint rules that conflict with Prettier formatting
      ...eslintConfigPrettier.rules,
      // Run Prettier as an ESLint rule (shows formatting issues in lint)
      "prettier/prettier": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
];
