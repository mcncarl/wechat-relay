// SPDX-License-Identifier: AGPL-3.0-or-later

const nodeGlobals = {
  AbortController: "readonly",
  Buffer: "readonly",
  Response: "readonly",
  TextDecoder: "readonly",
  URL: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  fetch: "readonly",
  process: "readonly",
  setTimeout: "readonly",
};

export default [
  {
    ignores: ["node_modules/**", "coverage/**", "data/**"],
  },
  {
    files: ["src/**/*.js", "scripts/**/*.mjs", "test/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: {
      "eqeqeq": "error",
      "no-console": "error",
      "no-constant-binary-expression": "error",
      "no-duplicate-imports": "error",
      "no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
      "prefer-const": "error"
    },
  },
];
