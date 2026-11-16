/**
 * Test helpers for code that uses @node-net/netconf. {@link FakeServer} is a
 * scripted NETCONF server that runs in the same process as your tests: give
 * `server.transport()` to `connect()`, answer each request with a handler,
 * then check what the client sent. No live device, network or container is
 * needed. See [Testing your code](/guide/testing).
 *
 * @packageDocumentation
 */
export {
  FakeServer,
  NOTIFICATION_NS,
  type FakeServerOptions,
  type RpcHandlerContext,
  type RpcErrorSpec,
  type RpcHandler,
  type RpcHandlerResult,
} from './fake-server.js';
