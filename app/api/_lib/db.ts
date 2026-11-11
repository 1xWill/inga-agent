// Ensure we run on the Node.js runtime only (native addon)
export const runtime = 'nodejs';
// Use the storage selector (SQLite locally, Postgres on Railway)
export { getRepository } from '../../../src/storage';
