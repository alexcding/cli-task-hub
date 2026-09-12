// Isolated test transport. Commands only affect connections through this proxy.
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const [socketPath, targetPath, directory] = process.argv.slice(2);
const file = name => path.join(directory, name);
const connections = new Set();
const server = net.createServer(front => {
  fs.appendFileSync(file('connections'), 'connected\n');
  const back = net.createConnection(targetPath);
  const pair = { front, back };
  connections.add(pair);
  const held = new Set();
  let input = '', output = '';
  function close() { front.destroy(); back.destroy(); connections.delete(pair); }
  front.on('error', close); back.on('error', close);
  front.on('close', close); back.on('close', close);
  front.on('data', bytes => {
    input += bytes.toString('utf8');
    for (;;) {
      const end = input.indexOf('\n');
      if (end < 0) break;
      const line = input.slice(0, end); input = input.slice(end + 1);
      const request = JSON.parse(line);
      if (request.op === 'create') fs.appendFileSync(file('creates'), 'create\n');
      if (request.op === 'write' && fs.existsSync(file('hold-write-reply'))) {
        held.add(request.id);
        fs.appendFileSync(file('write-seen'), `${request.bytes || request.data}\n`);
      }
      back.write(line + '\n');
    }
  });
  back.on('data', bytes => {
    output += bytes.toString('utf8');
    for (;;) {
      const end = output.indexOf('\n');
      if (end < 0) break;
      const line = output.slice(0, end); output = output.slice(end + 1);
      if (!held.has(JSON.parse(line).id)) front.write(line + '\n');
    }
  });
});
const timer = setInterval(() => {
  if (!fs.existsSync(file('drop'))) return;
  fs.unlinkSync(file('drop'));
  for (const { front, back } of connections) { front.destroy(); back.destroy(); }
}, 10);
server.listen(socketPath, () => fs.writeFileSync(file('proxy-ready'), 'ready'));
process.on('SIGTERM', () => {
  clearInterval(timer);
  for (const { front, back } of connections) { front.destroy(); back.destroy(); }
  server.close(() => process.exit(0));
});
