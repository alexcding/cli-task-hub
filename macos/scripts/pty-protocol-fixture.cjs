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
