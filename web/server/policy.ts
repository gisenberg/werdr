import { BlockList, isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

const privateNetworks = new BlockList();
for (const [ip, bits] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10]] as const) privateNetworks.addSubnet(ip, bits, 'ipv4');
privateNetworks.addAddress('::1', 'ipv6');
privateNetworks.addSubnet('fc00::', 7, 'ipv6');
export function allowedBind(host: string): boolean {
  const family = isIP(host);
  return !!family && privateNetworks.check(host, family === 4 ? 'ipv4' : 'ipv6');
}
export function equalToken(actual: string, expected: string): boolean {
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function dimension(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 2 || Number(value) > 500) throw new Error('Invalid terminal size');
  return Number(value);
}
export function terminalInput(value: any): object {
  if (value?.type === 'terminal.input' && typeof value.text === 'string' && Buffer.byteLength(value.text) <= 32768) return { type: value.type, text: value.text };
  if (value?.type === 'terminal.resize') return { type: value.type, cols: dimension(value.cols), rows: dimension(value.rows) };
  if (value?.type === 'terminal.scroll' && ['up', 'down'].includes(value.direction) && Number.isInteger(value.lines) && value.lines >= 1 && value.lines <= 100) return { type: value.type, direction: value.direction, lines: value.lines };
  throw new Error('Invalid terminal command');
}
