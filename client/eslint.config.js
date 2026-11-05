// Checks the app's page code for mistakes before they reach anyone:
//   npm run lint      (in client/)
// main.js is one classic script, so every top-level name is shared; the checks that
// matter most are names used but never defined, and names defined twice.

import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "src-tauri/**"] },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "script",
      globals: { ...globals.browser },
    },
    rules: {
      "no-redeclare": "error",
      "no-undef": "error",
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // The page tests run on top of main.js and mock.js and use their names freely.
    files: ["tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "script",
      globals: { ...globals.browser },
    },
    rules: { "no-undef": "off", "no-unused-vars": "off", "no-redeclare": "error", "no-empty": ["error", { allowEmptyCatch: true }] },
  },
  {
    files: ["tests/**/*.mjs", "eslint.config.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node } },
  },
];
