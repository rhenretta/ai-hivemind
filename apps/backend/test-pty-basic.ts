import * as pty from 'node-pty';

const term = pty.spawn('/bin/sh', ['-c', 'echo hello'], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    env: process.env as any
});

term.onData((data) => {
    console.log("RECEIVED:", data);
});
