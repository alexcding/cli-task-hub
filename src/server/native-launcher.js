const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { acquireNativeDataLock, prepareNativeData } = require('./database/native-checkpoint');

async function launchNativeBackend({ dataDirectory, releaseID, loadApplication = () => require('./app') }) {
  if (!dataDirectory) throw new Error('Packaged native startup requires an explicit data directory.');
  const lock = acquireNativeDataLock(dataDirectory);
  try {
    const checkpoint = await prepareNativeData(dataDirectory, releaseID, lock);
    console.log(`[native] data checkpoint: ${checkpoint.kind}${checkpoint.snapshot ? ` (${checkpoint.snapshot})` : ''}`);
    const application = loadApplication();
    try { await application.start(); }
    catch (error) { application.stop(); throw error; }
    return { application, release: lock.release };
  } catch (error) { lock.release(); throw error; }
}

module.exports = { launchNativeBackend };

if (require.main === module) {
  let application, running;
  const stop = () => {
    application?.stop();
    running?.release();
    // The process exit releases the lock even during an unfinished checkpoint.
    // Do not continue an asynchronous backup after receiving a quit request.
    process.exit(0);
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  Promise.resolve().then(async () => {
    const release = JSON.parse(fs.readFileSync(path.join(__dirname, '../../release.json'), 'utf8'));
    if (release?.format !== 1 || !/^[a-f0-9]{64}$/.test(release.id)) throw new Error('Packaged backend release metadata is missing or invalid.');
    const releaseID = createHash('sha256').update(`${release.id}:${process.version}`).digest('hex');
    process.env.TASKHUB_PACKAGED = '1';
    // Keep the lease reachable for the entire application lifetime. Otherwise
    // DatabaseSync finalization can release its lock while the server runs.
    running = await launchNativeBackend({ dataDirectory: process.env.TASKHUB_DATA_DIR, releaseID,
      loadApplication: () => { application = require('./app'); return application; } });
  }).catch(error => { console.error(`[native] startup stopped before readiness: ${error.message}`); process.exit(1); });
}
