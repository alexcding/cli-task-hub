// Shared constants for the Electron main-process modules.
const PORT = parseInt(process.env.PORT || '3000', 10);
const BASE_URL = `http://localhost:${PORT}`;

module.exports = { PORT, BASE_URL };
