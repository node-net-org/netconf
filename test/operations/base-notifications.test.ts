/**
 * RFC 6470 base-notification decoders (OPS-20).
 */
import { describe, expect, it } from 'vitest';
import { CapabilitySet, NOTIFICATION_NS, ProtocolError, parseXml, type Notification } from '../../src/index.js';
import {
  BaseNotificationError,
  NETCONF_NOTIFICATIONS_NS as NCN,
  decodeBaseNotification,
  decodeCapabilityChange,
  decodeConfigChange,
  decodeConfirmedCommit,
  decodeSessionEnd,
  decodeSessionStart,
  supportsBaseNotifications,
} from '../../src/operations/base-notifications.js';

const IF = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
const TIME = '2026-11-07T10:15:02Z';

/** A notification as the session builds it, from the event XML (and attributes for `<notification>`). */
function notification(event: string, outerAttrs = ''): Notification {
  const element = parseXml(`<notification xmlns="${NOTIFICATION_NS}"${outerAttrs}><eventTime>${TIME}</eventTime>${event}</notification>`);
  return { eventTime: TIME, event: element.elements[1], element };
}
const ev = (name: string, body: string, attrs = '') => notification(`<${name} xmlns="${NCN}"${attrs}>${body}</${name}>`);
const user = '<username>admin</username><session-id>42</session-id><source-host>192.0.2.10</source-host>';

function decodeError(n: Notification): BaseNotificationError {
  try {
    decodeBaseNotification(n);
  } catch (e) {
    return e as BaseNotificationError;
  }
  throw new Error('expected a BaseNotificationError');
}

describe('decodeBaseNotification (OPS-20)', () => {
  it('decodes the RFC example config change, with the target as an RFC 7951 path', () => {
    const n = ev(
      'netconf-config-change',
      `<changed-by>${user}</changed-by><datastore>running</datastore>` +
        `<edit><target xmlns:if="${IF}">/if:interfaces/if:interface[if:name='eth0']</target><operation>replace</operation></edit>`,
    );
    expect(decodeBaseNotification(n)).toEqual({
      type: 'netconf-config-change',
      eventTime: TIME,
      changedBy: { username: 'admin', sessionId: 42, sourceHost: '192.0.2.10' },
      datastore: 'running',
      edits: [
        {
          operation: 'replace',
          target: "/ietf-interfaces:interfaces/interface[name='eth0']",
        },
      ],
    });
  });

  it('defaults the datastore to running, allows no edits, and reports a server change', () => {
    const e = decodeConfigChange(ev('netconf-config-change', '<changed-by><server/></changed-by>'))!;
    expect(e).toMatchObject({ changedBy: { server: true }, datastore: 'running', edits: [] });
    expect(decodeConfigChange(ev('netconf-config-change', '<changed-by><server/></changed-by><datastore>startup</datastore>'))!.datastore).toBe('startup');
  });

  it('resolves target prefixes declared on <notification>, the event, <edit> or <target>', () => {
    const n = notification(
      `<netconf-config-change xmlns="${NCN}" xmlns:b="urn:b"><changed-by><server/></changed-by>` +
        `<edit xmlns:c="urn:c"><target xmlns:d="urn:d">/a:x/b:y/c:z/d:w</target></edit></netconf-config-change>`,
      ` xmlns:a="urn:a"`,
    );
    // modules no source knows are named by their namespace, as the JSON conversion does
    expect(decodeConfigChange(n)!.edits[0]!.target).toBe('/urn:a:x/urn:b:y/urn:c:z/urn:d:w');
  });

  it('names modules by the session\'s lookup when given one, and writes a module only where it changes', () => {
    const n = ev(
      'netconf-config-change',
      `<changed-by><server/></changed-by><edit><target xmlns:if="${IF}" xmlns:ip="urn:ip">/if:interfaces/if:interface[if:name='eth0']/ip:ipv4</target></edit>`,
    );
    const moduleOf = (ns: string): string | undefined => (ns === 'urn:ip' ? 'ietf-ip' : undefined);
    expect(decodeConfigChange(n, { moduleOf })!.edits[0]!.target).toBe("/ietf-interfaces:interfaces/interface[name='eth0']/ietf-ip:ipv4");
  });

  it('decodes a capability change', () => {
    const n = ev(
      'netconf-capability-change',
      '<changed-by><server/></changed-by><added-capability>urn:a</added-capability><added-capability>urn:b</added-capability>' +
        '<modified-capability>urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&amp;content-id=2</modified-capability>',
    );
    expect(decodeCapabilityChange(n)).toEqual({
      type: 'netconf-capability-change',
      eventTime: TIME,
      changedBy: { server: true },
      added: ['urn:a', 'urn:b'],
      deleted: [],
      modified: ['urn:ietf:params:netconf:capability:yang-library:1.1?revision=2019-01-04&content-id=2'],
    });
  });

  it('decodes session start and end; session-id 0 is a non-NETCONF session; source-host is optional', () => {
    expect(decodeSessionStart(ev('netconf-session-start', '<username>cli</username><session-id>0</session-id>'))).toEqual({
      type: 'netconf-session-start',
      eventTime: TIME,
      session: { username: 'cli', sessionId: 0 },
    });
    expect(decodeSessionEnd(ev('netconf-session-end', `${user}<killed-by>7</killed-by><termination-reason>killed</termination-reason>`))).toEqual({
      type: 'netconf-session-end',
      eventTime: TIME,
      session: { username: 'admin', sessionId: 42, sourceHost: '192.0.2.10' },
      terminationReason: 'killed',
      killedBy: 7,
    });
    expect(decodeSessionEnd(ev('netconf-session-end', `${user}<termination-reason>dropped</termination-reason>`))).not.toHaveProperty('killedBy');
  });

  it('decodes confirmed-commit start with a timeout, and timeout with no session', () => {
    expect(decodeConfirmedCommit(ev('netconf-confirmed-commit', `${user}<confirm-event>start</confirm-event><timeout>600</timeout>`))).toEqual({
      type: 'netconf-confirmed-commit',
      eventTime: TIME,
      session: { username: 'admin', sessionId: 42, sourceHost: '192.0.2.10' },
      confirmEvent: 'start',
      timeout: 600,
    });
    expect(decodeConfirmedCommit(ev('netconf-confirmed-commit', '<confirm-event>timeout</confirm-event>'))).toEqual({
      type: 'netconf-confirmed-commit',
      eventTime: TIME,
      confirmEvent: 'timeout',
    });
  });

  it('tolerates whitespace around values and ignores unknown (augmented) children', () => {
    const n = ev('netconf-session-end', `<username> admin </username><session-id> 42 </session-id><termination-reason>\n closed \n</termination-reason><vendor xmlns="urn:v">x</vendor>`);
    expect(decodeSessionEnd(n)).toMatchObject({ session: { username: 'admin', sessionId: 42 }, terminationReason: 'closed' });
  });

  it('returns undefined for other notifications, other namespaces, and no event', () => {
    expect(decodeBaseNotification(notification('<link-down xmlns="urn:example"/>'))).toBeUndefined();
    expect(decodeBaseNotification(notification('<netconf-session-start xmlns="urn:other"><username>a</username></netconf-session-start>'))).toBeUndefined();
    expect(decodeBaseNotification(ev('netconf-unknown', ''))).toBeUndefined();
    expect(decodeBaseNotification(ev('toString', ''))).toBeUndefined();
    const empty = parseXml(`<notification xmlns="${NOTIFICATION_NS}"><eventTime>${TIME}</eventTime></notification>`);
    expect(decodeBaseNotification({ eventTime: TIME, event: undefined, element: empty })).toBeUndefined();
  });

  it('a per-event decoder returns undefined for the other base events', () => {
    const start = ev('netconf-session-start', user);
    expect(decodeSessionEnd(start)).toBeUndefined();
    expect(decodeConfigChange(start)).toBeUndefined();
    expect(decodeSessionStart(start)?.type).toBe('netconf-session-start');
  });

  it.each([
    ['netconf-config-change', '', 'changed-by', /is missing/],
    ['netconf-config-change', '<changed-by/>', 'changed-by', /neither server nor session/],
    ['netconf-config-change', '<changed-by><session-id>1</session-id></changed-by>', 'changed-by/username', /missing/],
    ['netconf-config-change', '<changed-by><username>a</username></changed-by>', 'changed-by/session-id', /missing/],
    ['netconf-config-change', '<changed-by><server/></changed-by><datastore>candidate</datastore>', 'datastore', /unknown value "candidate"/],
    ['netconf-config-change', '<changed-by><server/></changed-by><edit><operation>patch</operation></edit>', 'edit/operation', /unknown value/],
    ['netconf-config-change', '<changed-by><server/></changed-by><edit><target>/if:interfaces</target></edit>', 'edit/target', /undeclared prefix "if"/],
    ['netconf-config-change', '<changed-by><server/></changed-by><edit><target>interfaces</target></edit>', 'edit/target', /expected "\/"/],
    ['netconf-session-start', '<username>a</username>', 'session-id', /missing/],
    ['netconf-session-start', '<username>a</username><session-id>-1</session-id>', 'session-id', /integer from 0/],
    ['netconf-session-start', '<username>a</username><session-id>4294967296</session-id>', 'session-id', /integer from 0/],
    ['netconf-session-end', user, 'termination-reason', /missing/],
    ['netconf-session-end', `${user}<termination-reason>bye</termination-reason>`, 'termination-reason', /unknown value/],
    ['netconf-session-end', `${user}<killed-by>0</killed-by><termination-reason>killed</termination-reason>`, 'killed-by', /integer from 1/],
    ['netconf-confirmed-commit', user, 'confirm-event', /missing/],
    ['netconf-confirmed-commit', `${user}<confirm-event>start</confirm-event><timeout>soon</timeout>`, 'timeout', /integer/],
    ['netconf-confirmed-commit', '<username>a</username><confirm-event>cancel</confirm-event>', 'session-id', /missing/],
  ])('%s with %s throws a ProtocolError naming %s', (name, body, field, message) => {
    const err = decodeError(ev(name, body));
    expect(err).toBeInstanceOf(BaseNotificationError);
    expect(err).toBeInstanceOf(ProtocolError);
    expect(err).toMatchObject({ event: name, field, code: 'ERR_NETCONF_BASE_NOTIFICATION' });
    expect(err.message).toMatch(message);
    expect(err.message).toContain(name);
    expect(err.element.name).toBe(name);
  });
});

describe('supportsBaseNotifications', () => {
  it('looks for the ietf-netconf-notifications module in the hello', () => {
    expect(supportsBaseNotifications(new CapabilitySet([`${NCN}?module=ietf-netconf-notifications&revision=2012-02-06`]))).toBe(true);
    expect(supportsBaseNotifications(new CapabilitySet([NCN]))).toBe(true);
    expect(supportsBaseNotifications(new CapabilitySet(['urn:ietf:params:netconf:capability:notification:1.0']))).toBe(false);
  });
});
