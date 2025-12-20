import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintPluginUnicorn.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Relax rules that conflict with our codebase patterns
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off', // We use console.error for logging

      // Unicorn rule adjustments
      'unicorn/prevent-abbreviations': 'off', // We use common abbreviations like conn, cmd, etc.
      'unicorn/no-null': 'off', // We use null intentionally in many places
      'unicorn/filename-case': 'off', // We use kebab-case which is fine
      'unicorn/no-process-exit': 'off', // CLI tools need process.exit
      'unicorn/prefer-top-level-await': 'off', // CLI tools use main().catch() pattern
      'unicorn/import-style': 'off', // We use * as path which is fine
      'unicorn/prefer-ternary': 'off', // Often less readable than if/else
      'unicorn/text-encoding-identifier-case': 'off', // utf-8 is valid
      'unicorn/catch-error-name': 'off', // err is a common convention
      'unicorn/switch-case-braces': 'off', // Not always needed
      'unicorn/no-negated-condition': 'off', // Sometimes clearer with negation
      'unicorn/prefer-code-point': 'off', // charCodeAt is fine for ASCII
      'unicorn/no-useless-switch-case': 'off', // Default fallthrough is intentional
      'unicorn/prefer-single-call': 'off', // Multiple push calls are often clearer
      'unicorn/prefer-number-properties': 'off', // isNaN has different semantics than Number.isNaN
    },
  },
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'src/tests/**', // Test files
      'src/repl.ts', // REPL utility
      '*.js', // Ignore JS files in root (config files)
    ],
  }
);
