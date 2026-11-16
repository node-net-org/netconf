/**
 * Layer rules for @node-net/netconf. See docs/net-netconf-design.md §3.2.
 *
 * The stack follows RFC 6241: transport (with framing) < messages <
 * operations < content. Dependencies only point downwards, layers use each
 * other only through their index.ts barrel, and nothing below the client
 * facade imports client.ts, index.ts, device profiles or test support.
 */
/** The adapter modules that import @node-net/yang code: loaded only through src/yang/load.ts. */
const YANG_ENGINE = '^src/yang/(engine|convert|diff|encode|filter|operation|schemas)\\.ts$';
const SHARED = '^src/(errors|logger|frozen-map|timers)\\.ts$';
const barrel = (layer) => `^src/${layer}/index\\.ts$`;
/**
 * The modules only the Node entry reaches (index.ts, call home, the SSH, TLS
 * and known_hosts transports, the stream adapter, file loaders). Everything
 * else in src is portable: it is @node-net/netconf/core and @node-net/netconf/testing,
 * and runs in any JavaScript runtime. Kept in step with eslint.config.js.
 */
const NODE_ONLY = [
  '^src/(index|call-home)\\.ts$',
  '^src/transport/(node|ssh|tls|call-home|host-keys|fingerprint|duplex)\\.ts$',
  '^src/devices/profile-loader\\.ts$',
  '^src/yang/files\\.ts$',
];

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'shared-leaves',
      comment: 'src/errors.ts and src/logger.ts are imported by every layer, so they import nothing internal.',
      severity: 'error',
      from: { path: SHARED },
      to: { path: '^src/' },
    },
    {
      name: 'xml-is-a-leaf',
      comment: 'The XML library imports only itself and the shared leaves.',
      severity: 'error',
      from: { path: '^src/xml/' },
      to: { path: '^src/', pathNot: ['^src/xml/', SHARED] },
    },
    {
      name: 'yang-adapter-is-a-leaf',
      comment: 'The YANG adapter (RFC 7951 JSON through @node-net/yang) imports only itself, the XML library and the shared leaves.',
      severity: 'error',
      from: { path: '^src/yang/' },
      to: { path: '^src/', pathNot: ['^src/yang/', '^src/xml/', SHARED] },
    },
    {
      name: 'net-yang-only-in-the-adapter',
      comment: 'Only the YANG adapter imports @node-net/yang, so no layer depends on a YANG implementation (design §3.5).',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/yang/' },
      to: { path: '(^|/)@node-net/yang/' },
    },
    {
      name: 'yang-machinery-loads-on-demand',
      comment:
        'The YANG machinery (engine.ts and the conversion modules behind it, which import @node-net/yang code) is reached only by load.ts\'s import(), so @node-net/netconf/core costs no YANG code until a conversion runs (design §12). Elsewhere, @node-net/yang is imported for types, or for its error class through src/yang/errors.ts.',
      severity: 'error',
      from: { path: '^src/', pathNot: [YANG_ENGINE, '^src/yang/(errors|files)\\.ts$'] },
      to: { path: [YANG_ENGINE, '(^|/)@node-net/yang/'], dependencyTypesNot: ['type-only', 'dynamic-import'] },
    },
    {
      name: 'framing-is-a-leaf',
      comment: 'Framing never sees XML or a connection: only itself and the shared leaves.',
      severity: 'error',
      from: { path: '^src/transport/framing/' },
      to: { path: '^src/', pathNot: ['^src/transport/framing/', SHARED] },
    },
    {
      name: 'transport-layer',
      comment: 'Transport imports only itself (including framing) and the shared leaves. It never sees XML.',
      severity: 'error',
      from: { path: '^src/transport/' },
      to: { path: '^src/', pathNot: ['^src/transport/', SHARED] },
    },
    {
      name: 'messages-layer',
      comment: 'Messages may use the transport barrel, the XML library and the shared leaves.',
      severity: 'error',
      from: { path: '^src/messages/' },
      to: { path: '^src/', pathNot: ['^src/messages/', barrel('transport'), '^src/xml/', SHARED] },
    },
    {
      name: 'operations-layer',
      comment: 'Operations may use the messages barrel, the XML library and the shared leaves.',
      severity: 'error',
      from: { path: '^src/operations/' },
      to: { path: '^src/', pathNot: ['^src/operations/', barrel('messages'), '^src/xml/', SHARED] },
    },
    {
      name: 'content-layer',
      comment: 'Content may use the operations and messages barrels, the XML library and the shared leaves.',
      severity: 'error',
      from: { path: '^src/content/' },
      to: { path: '^src/', pathNot: ['^src/content/', barrel('operations'), barrel('messages'), '^src/xml/', SHARED] },
    },
    {
      name: 'device-support',
      comment: 'The profile format, loader and detection may use every layer barrel, but not the client or the public barrel.',
      severity: 'error',
      from: { path: '^src/devices/[^/]+\\.ts$' },
      to: {
        path: '^src/',
        pathNot: [
          '^src/devices/[^/]+\\.ts$',
          barrel('transport'),
          barrel('messages'),
          barrel('operations'),
          barrel('content'),
          '^src/xml/',
          SHARED,
        ],
      },
    },
    {
      name: 'device-profiles-use-public-api-only',
      comment: 'A TypeScript device profile may import the public API and files in its own folder only.',
      severity: 'error',
      from: { path: '^src/devices/([^/]+)/' },
      to: { path: '^src/', pathNot: ['^src/index\\.ts$', '^src/devices/$1/'] },
    },
    {
      name: 'nothing-below-the-client-imports-it',
      comment: 'Only index.ts, the call-home facade beside it, and test support may import the client facade; its layer objects (client-ops, client-content, and the helpers client-modules and client-configure) are imported only by the facade and each other.',
      severity: 'error',
      from: { path: '^src/', pathNot: ['^src/(index|core)\\.ts$', '^src/call-home\\.ts$', '^src/testing/', '^src/client(-ops|-content|-yang|-modules|-configure)?\\.ts$'] },
      to: { path: '^src/client(-ops|-content|-yang|-modules|-configure)?\\.ts$' },
    },
    {
      name: 'portable-core-no-node-builtins',
      comment: '@node-net/netconf/core and @node-net/netconf/testing run in any JavaScript runtime, so portable modules import no Node built-in (src/core.ts).',
      severity: 'error',
      from: { path: '^src/', pathNot: NODE_ONLY },
      to: { dependencyTypes: ['core'], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'portable-core-no-node-only-modules',
      comment: 'Portable modules never load the Node-only ones (types are fine: they cost nothing at run time).',
      severity: 'error',
      from: { path: '^src/', pathNot: NODE_ONLY },
      to: { path: NODE_ONLY, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'portable-core-no-ssh2-or-node-net-yang',
      comment: 'Portable modules never load ssh2, and use @node-net/yang/core rather than the Node entry of @node-net/yang.',
      severity: 'error',
      from: { path: '^src/', pathNot: NODE_ONLY },
      to: { path: ['(^|/)node_modules/ssh2/', '(^|/)@node-net/yang/dist/index\\.js$'], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'only-test-support-imports-testing',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/testing/' },
      to: { path: '^src/testing/' },
    },
    {
      name: 'src-does-not-import-tests',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^test/' },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-undeclared-runtime-deps',
      comment: 'Runtime code may only use node builtins and declared dependencies.',
      severity: 'error',
      from: { path: '^src/' },
      to: { dependencyTypes: ['npm-dev', 'npm-no-pkg', 'npm-unknown', 'undetermined'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // @node-net/yang may be a workspace link: keep its node_modules path, so it counts as the declared dependency it is.
    preserveSymlinks: true,
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js'],
    },
  },
};
