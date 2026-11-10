#!/usr/bin/env node
/** Small helper: send one JSON message to the vibe hub and print replies. */
import net from 'node:net';

const PIPE = process.env.VIBE_PIPE || '\\\\.\\pipe\\vibe-keyboard-hub';
const msg = JSON.parse(process.argv[2] || '{"t":"status"}');
const waitMs = Number(process.argv[3] || 1500);

const sock = net.connect(PIPE);
let buf = '';
sock.on('error', (e) => { console.error('pipe error:', e.message); process.exit(1); });
sock.on('connect', () => {
  sock.write(JSON.stringify(msg) + '\n');
  setTimeout(() => { sock.destroy(); process.exit(0); }, waitMs);
});
sock.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (l) console.log(l);
  }
});
