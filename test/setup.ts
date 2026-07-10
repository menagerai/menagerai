// Provide env so config.ts loads without a real .env during tests. No real
// connection is made — modules under test never call connect().
process.env.MONGODB_CONN_STR ||= 'mongodb://localhost:27017';
process.env.MONGODB_DB ||= 'menagerai_test';
process.env.PORTAL_BASE_URL ||= 'https://portal.test';
process.env.DEFAULT_BASE_URLS ||= 'app.example.com,app2.example.com';
process.env.COOKIE_SECURE ||= 'false';
process.env.DECISION_CACHE_TTL_MS ||= '30000';
