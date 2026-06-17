// Shared route plumbing. Routes are thin glue (parse → call a service/repository →
// serialize); wrap() gives them a uniform 500-on-throw error path. Async-aware: it
// awaits the handler, so handlers that hit the (async) CLI/REST repositories get the
// same catch as sync ones (await of a sync return is a no-op).
const wrap = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (err) { res.status(500).json({ error: err.message }); }
};

module.exports = { wrap };
