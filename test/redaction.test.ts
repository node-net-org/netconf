/**
 * MESSAGES-18: the default redaction of logged XML.
 */
import { describe, expect, it } from 'vitest';
import { redactXml } from '../src/index.js';

describe('redactXml (MESSAGES-18)', () => {
  it.each([
    'password',
    'auth-password',
    'encrypted-password',
    'passphrase',
    'secret',
    'shared-secret',
    'cleartext-private-key',
    'preshared-key',
    'pre-shared-key',
    'psk',
    'community',
    'key-string',
    'authentication-key',
    'auth-key',
    'md5-key',
    'key',
    'token',
    'access-token',
    'PASSWORD',
  ])('AC4: hides the text of <%s>', (name) => {
    expect(redactXml(`<a><${name}>s3cret</${name}><b>kept</b></a>`)).toBe(`<a><${name}>***</${name}><b>kept</b></a>`);
  });

  it.each(['public-key', 'key-id', 'token-bucket', 'keychain', 'name', 'description'])('AC4: leaves <%s> alone', (name) => {
    const xml = `<${name}>visible</${name}>`;
    expect(redactXml(xml)).toBe(xml);
  });

  it('AC4: hides CDATA content', () => {
    expect(redactXml('<password><![CDATA[s3<cr>et]]></password>')).toBe('<password><![CDATA[***]]></password>');
    expect(redactXml('<name><![CDATA[x<y]]></name>')).toBe('<name><![CDATA[x<y]]></name>');
  });

  it('AC4: allows whitespace and attributes in the tags, and prefixes', () => {
    expect(redactXml('<sys:password  a="1" b=\'>\'>s3cret</sys:password >')).toBe('<sys:password  a="1" b=\'>\'>***</sys:password >');
    expect(redactXml('<password\n>s3cret</password\n>')).toBe('<password\n>***</password\n>');
  });

  it('AC4: hides everything inside a secret element, at any depth', () => {
    expect(redactXml('<secret>\n  <value>s3cret</value>\n  <hash/>h\n</secret><n>ok</n>')).toBe(
      '<secret>\n  <value>***</value>\n  <hash/>***</secret><n>ok</n>',
    );
  });

  it('AC4: keeps everything else exactly as it was', () => {
    const xml =
      '<?xml version="1.0"?>\n<rpc message-id="1" xmlns="urn:ietf:params:xml:ns:netconf:base:1.0">' +
      '<!-- <password>in a comment</password> --><get-config><source><running/></source></get-config></rpc>';
    expect(redactXml(xml)).toBe(xml);
    expect(redactXml('')).toBe('');
    expect(redactXml('plain text')).toBe('plain text');
  });

  it('AC4: never throws on malformed XML, and still redacts it', () => {
    expect(redactXml('<password>s3cret')).toBe('<password>***');
    expect(redactXml('<password>s3cret</other></password><n>x</n>')).toBe('<password>***</other></password><n>x</n>');
    expect(redactXml('</password>x<n')).toBe('</password>x<n');
    expect(redactXml('<password><![CDATA[s3cret')).toBe('<password><![CDATA[***');
    expect(redactXml('<a><password>s3cret</a><n>after</n>')).toBe('<a><password>***</a><n>after</n>');
  });

  it('AC7: strips userinfo from URLs', () => {
    expect(redactXml('<url>ftp://admin:s3cret@10.0.0.1/backup.cfg</url>')).toBe('<url>ftp://***@10.0.0.1/backup.cfg</url>');
    expect(redactXml('<target><url>scp://bob@host:/x</url></target>')).toBe('<target><url>scp://***@host:/x</url></target>');
    expect(redactXml('<url>https://host/a@b</url>')).toBe('<url>https://host/a@b</url>');
    expect(redactXml('<message>see sftp://u:p@h/f</message>')).toBe('<message>see sftp://***@h/f</message>');
  });

  it('is linear: a large message with many unmatched close tags is quick', () => {
    const big = '<a>'.repeat(50_000) + '</b>'.repeat(50_000);
    const start = performance.now();
    redactXml(big);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});
