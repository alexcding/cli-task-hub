// Isolated Unix-socket peer for Swift transport failure tests; never spawns a PTY.
const net = require('node:net');
const fs = require('node:fs');
const [socketPath, readyFile, mode] = process.argv.slice(2);
const server = net.createServer(socket => {
  socket.on('error', () => {});
  let pending = '';
  socket.on('data', data => {
    pending += data.toString('utf8');
    for (;;) {
      const end = pending.indexOf('\n');
      if (end < 0) break;
      const request = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      const reply = ok => {
        if (!socket.destroyed) socket.write(JSON.stringify({ id: request.id, ok }) + '\n');
      };
      switch (request.op) {
        case 'snapshotBegin':
          reply({ token: 1, size: mode === 'snapshot-oversize' ? 33554433 : 131075,
            chunkBytes: 131072, seq: 7, stateSeq: 9, cols: 80, rows: 24,
            revision: '82938b633ba646db38591d969c3c526332bd7e65' });
          break;
        case 'snapshotRead': {
          fs.appendFileSync(`${readyFile}.reads`, `${request.offset}\n`);
          const size = Math.min(131072, 131075 - request.offset);
          const chunk = { token: mode === 'snapshot-token' ? 2 : request.token,
            offset: mode === 'snapshot-offset' ? request.offset + 1 : request.offset,
            bytes: Buffer.alloc(mode === 'snapshot-short' ? size - 1 : size, 120).toString('base64'),
            done: mode === 'snapshot-early' || request.offset + size === 131075 };
          if (mode === 'snapshot-cancel') setTimeout(() => reply(chunk), 100);
          else reply(chunk);
          break;
        }
        case 'snapshotEnd':
          fs.appendFileSync(`${readyFile}.released`, `${request.token}\n`);
          reply(true);
          break;
        case 'hello': reply({ protocol: mode === 'mismatch' ? 999 : 2, pid: process.pid }); break;
        case 'write':
          fs.appendFileSync(`${readyFile}.writes`, `${request.bytes}\n`);
          socket.write(JSON.stringify({ id: request.id, err: 'fixture input queue is full' }) + '\n');
          break;
        case 'slow': setTimeout(() => reply('stale reply'), 100); break;
        case 'list': setTimeout(() => reply([]), 180); break;
        case 'drop': socket.destroy(); break;
        case 'malformed': socket.write('{broken\n'); break;
      }
    }
  });
});
server.listen(socketPath, () => fs.writeFileSync(readyFile, 'ready'));
