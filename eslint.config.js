import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/** The modules only the Node entry reaches; everything else in src is portable. Kept in step with .dependency-cruiser.cjs. */
const NODE_ONLY = [
  'src/index.ts',
  'src/call-home.ts',
  'src/transport/node.ts',
  'src/transport/ssh.ts',
  'src/transport/tls.ts',
  'src/transport/call-home.ts',
  'src/transport/host-keys.ts',
  'src/transport/fingerprint.ts',
  'src/transport/duplex.ts',
  'src/devices/profile-loader.ts',
  'src/yang/files.ts',
];

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js', '*.cjs', 'scripts/*.cjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
      'no-restricted-syntax': [
        'error',
        {
          // require(esm) fails for modules with top-level await (design §12).
          selector: 'AwaitExpression:not(:function AwaitExpression)',
          message: 'Top-level await breaks require(esm) for CommonJS consumers.',
        },
        {
          selector: 'ForOfStatement[await=true]:not(:function ForOfStatement)',
          message: 'Top-level for-await breaks require(esm) for CommonJS consumers.',
        },
        {
          // A listener-less 'error' event crashes Node (fork defect b). Never emit one.
          selector: "CallExpression[callee.property.name='emit'][arguments.0.value='error']",
          message: "Do not emit 'error' events; report failures through promises or the 'closed' event.",
        },
      ],
    },
  },
  {
    // @node-net/netconf/core and @node-net/netconf/testing run in any JavaScript runtime
    // (src/core.ts): no Node built-ins, no ssh2, no Node-only globals. The Node
    // entry and the modules only it reaches are exempt. dependency-cruiser and
    // portable:check enforce the same from other angles.
    files: ['src/**/*.ts'],
    ignores: NODE_ONLY,
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^node:', message: 'Portable code (@node-net/netconf/core) must not import Node built-ins.' },
            { regex: '^ssh2$', allowTypeImports: true, message: 'Portable code must not load ssh2.' },
            { regex: '^@node-net/yang$', allowTypeImports: true, message: 'Portable code imports @node-net/yang/core; the root @node-net/yang needs Node.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...['Buffer', 'process', 'require', '__dirname', '__filename', 'setImmediate', 'clearImmediate', 'global'].map((name) => ({
          name,
          message: 'Portable code (@node-net/netconf/core) must not use Node-only globals.',
        })),
      ],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: ['**/*.js', '**/*.cjs', 'scripts/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Developer scripts run directly with node: console output and top-level await are fine.
    files: ['scripts/*.mjs'],
    rules: { 'no-console': 'off', 'no-restricted-syntax': 'off' },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off', 'no-console': 'off' },
  },
);
