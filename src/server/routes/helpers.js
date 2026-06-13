// Shared route plumbing. Routes are thin glue (parse → call a service/repository →
// serialize); wrap() gives the sync ones a uniform 500-on-throw error path.
const wrap = fn => (req, res) => {
  try { fn(req, res); }
  catch (err) { res.status(500).json({ error: err.message }); }
};

module.exports = { wrap };
