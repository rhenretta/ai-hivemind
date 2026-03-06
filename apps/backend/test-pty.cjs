import * as pty from 'node-pty';

const gemini = pty.spawn('gemini', ['-y', '-e', 'conductor'], {
    name: 'xterm-color',
    cols: 120,
    rows: 40,
    cwd: process.cwd(),
    env: process.env
});

let buffer = '';
let phase = 'init';

gemini.onData((data) => {
    process.stdout.write(data);
    const text = data.replace(/\x1B\[[0-9;]*[mGKFH]/g, '');
    buffer += text;
    if (buffer.length > 8000) buffer = buffer.slice(-8000);

    if (phase === 'init' && buffer.includes('Type your message')) {
        phase = 'newTrack';
        buffer = '';
        console.log('\n[TEST] ─── DETECTED PROMPT, WRITING NEWTRACK ───\n');
        gemini.write('/conductor:newTrack "Test PTY"\r');
    }
    else if (phase === 'newTrack' && buffer.includes('Please provide your answers')) {
        phase = 'answering';
        buffer = '';
        console.log('\n[TEST] ─── DETECTED ASK_USER, WRITING ANSWER ───\n');
        gemini.write('Just use standard styling and simple logic please\r');
    }
    else if (phase === 'answering' && buffer.includes('Type your message')) {
        console.log('\n[TEST] ─── DETECTED TURN END ───\n');
        gemini.kill('SIGTERM');
        process.exit(0);
    }
});
