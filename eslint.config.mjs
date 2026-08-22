import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', '.next/**', 'next-env.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The core purity boundary. src/core/ is pure: no I/O, no persistence,
    // no framework. Enforced here and re-asserted in tests/core/boundary.test.ts,
    // because a lint rule can be silenced inline and a test cannot.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/db/*', '**/db'], message: 'core must not reach into persistence' },
          { group: ['**/app/*', '**/app'], message: 'core must not reach into the app layer' },
          { group: ['**/components/*'], message: 'core must not reach into UI' },
          { group: ['next', 'next/*'], message: 'core must not depend on the framework' },
          { group: ['react', 'react-dom'], message: 'core must not depend on React' },
        ],
      }],
    },
  },
);
