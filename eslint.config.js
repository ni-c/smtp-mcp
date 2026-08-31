// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'docs/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Plain-JavaScript scripts: the asset generator and the sandbox smoke test.
    // The TypeScript sources get these from tsconfig's "types": ["node"]; a
    // .mjs file has no such declaration, so the globals are named here instead
    // of pulling in the whole `globals` package for four of them. `fetch` is
    // global from Node 18 on and is what the smoke test reads Mailpit with.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
      },
    },
  }
);
