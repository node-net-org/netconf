/**
 * Comparing configuration datastores in the client (CONTENT-11) against netopeer2, which has no RFC 9144 compare:
 * the candidate's changes are worked out from two get-configs, typed with
 * the ietf-netconf-acm schema netopeer2 serves with get-schema.
 *
 *   scripts/netopeer2.sh start
 *   npm run test:integration
 *
 * The NACM groups list is the test data. Skipped unless NETOPEER2_PORT is set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, ssh, subtree, x, type ConnectOptions, type NetconfClient } from '../../src/index.js';
import { withCandidate, type DatastoreChange } from '../../src/operations/transaction.js';

const PORT = Number(process.env['NETOPEER2_PORT'] ?? 0);
const NACM = 'urn:ietf:params:xml:ns:yang:ietf-netconf-acm';
const GROUPS = ['nn-cmp-keep', 'nn-cmp-old', 'nn-cmp-new'];
const GROUP = (name: string): string => `/ietf-netconf-acm:nacm/groups/group[name='${name}']`;

let fingerprint = '';
let client: NetconfClient;

const options = (): ConnectOptions => ({
  transport: ssh({ host: '127.0.0.1', port: PORT, username: 'netconf', password: 'netconf', hostKey: fingerprint }),
  timeouts: { rpc: 10_000 },
});

const groups = () => subtree(x('nacm', { xmlns: NACM }, x('groups')));
const byPath = (changes: readonly DatastoreChange[]): DatastoreChange[] => [...changes].sort((a, b) => a.path.localeCompare(b.path));

async function removeGroups(): Promise<void> {
  await client.content.configure((txn) => {
    for (const g of GROUPS) txn.remove(`/ietf-netconf-acm:nacm/groups/group[name="${g}"]`);
  });
}

describe.skipIf(PORT === 0)('compareDatastores against netopeer2', () => {
  beforeAll(async () => {
    client = await connect({
      transport: ssh({
        host: '127.0.0.1',
        port: PORT,
        username: 'netconf',
        password: 'netconf',
        hostKey: (info) => {
          fingerprint = info.fingerprint;
          return true;
        },
      }),
      timeouts: { rpc: 10_000 },
    });
    await removeGroups();
    // Running holds nn-cmp-keep (user a) and nn-cmp-old.
    await client.content.configure((txn) => {
      txn.set('/ietf-netconf-acm:nacm/groups/group[name="nn-cmp-keep"]/user-name[.="a"]', null);
      txn.set('/ietf-netconf-acm:nacm/groups/group[name="nn-cmp-old"]/user-name[.="z"]', null);
    });
  });

  afterAll(async () => {
    if (client === undefined) return;
    await client.ops.discardChanges().catch(() => undefined);
    await removeGroups();
    await client.close();
  });

  it('reports exactly the candidate edits, then nothing once they are discarded', async () => {
    await withCandidate(client, async (txn) => {
      await txn.editConfig({
        config: x(
          'nacm',
          { xmlns: NACM },
          x(
            'groups',
            x('group', x('name', 'nn-cmp-keep'), x('user-name', 'b')),
            x('group', { operation: { ns: 'urn:ietf:params:xml:ns:netconf:base:1.0', prefix: 'nc', value: 'delete' } }, x('name', 'nn-cmp-old')),
            x('group', x('name', 'nn-cmp-new'), x('user-name', 'c')),
          ),
        ),
      });
      const changes = await txn.getCandidateChanges({ filter: groups() });
      expect(byPath(changes)).toEqual(
        byPath([
          { operation: 'create', path: `${GROUP('nn-cmp-keep')}/user-name[.='b']`, value: 'b' },
          { operation: 'delete', path: GROUP('nn-cmp-old'), previous: { name: 'nn-cmp-old', 'user-name': ['z'] } },
          { operation: 'create', path: GROUP('nn-cmp-new'), value: { name: 'nn-cmp-new', 'user-name': ['c'] } },
        ]),
      );
      // Reviewed and rejected: nothing is committed.
      throw new Error('not approved');
    }).catch((err: unknown) => {
      if (!(err instanceof Error && err.cause instanceof Error && err.cause.message === 'not approved')) throw err;
    });

    expect(await client.content.getCandidateChanges({ filter: groups() })).toEqual([]);
    expect(await client.content.compareDatastores({ source: 'running', target: 'candidate' })).toEqual([]);
  });

  it('compares running with startup', async () => {
    const other = await connect(options());
    try {
      const changes = await other.content.compareDatastores({ source: 'startup', target: 'running', filter: groups() });
      // beforeAll changed running only, so startup lacks both test groups: each is created, or inside a created ancestor.
      for (const g of ['nn-cmp-keep', 'nn-cmp-old']) {
        expect(changes.some((c) => c.operation === 'create' && (GROUP(g) === c.path || GROUP(g).startsWith(`${c.path}/`)))).toBe(true);
      }
    } finally {
      await other.close();
    }
  });
});
