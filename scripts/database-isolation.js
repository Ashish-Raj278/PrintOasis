const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/i;

function parseConnection(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required to verify Supabase database isolation.`);
  let url;
  try { url = new URL(value); }
  catch { throw new Error(`${label} is not a valid PostgreSQL connection URI.`); }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol) || !url.hostname || url.pathname.length < 2) {
    throw new Error(`${label} must be a complete PostgreSQL connection URI.`);
  }
  return url;
}

function supabaseProjectRef(url, label) {
  const directMatch = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (directMatch && PROJECT_REF_PATTERN.test(directMatch[1])) return directMatch[1].toLowerCase();
  if (/^[a-z0-9-]+\.pooler\.supabase\.com$/i.test(url.hostname)) {
    let username;
    try { username = decodeURIComponent(url.username); }
    catch { throw new Error(`${label} has an invalid Supabase Session Pooler username.`); }
    const poolerMatch = username.match(/^postgres\.([a-z0-9]+)$/i);
    if (poolerMatch && PROJECT_REF_PATTERN.test(poolerMatch[1])) return poolerMatch[1].toLowerCase();
  }
  throw new Error(`${label} does not identify a supported Supabase project.`);
}

function assertIsolatedSupabaseTestDatabase({ databaseUrl, testDatabaseUrl }) {
  const productionRef = supabaseProjectRef(parseConnection(databaseUrl, "DATABASE_URL"), "DATABASE_URL");
  const testRef = supabaseProjectRef(parseConnection(testDatabaseUrl, "TEST_DATABASE_URL"), "TEST_DATABASE_URL");
  if (productionRef === testRef) throw new Error("TEST_DATABASE_URL must target a different Supabase project from DATABASE_URL.");
  return true;
}

module.exports = { assertIsolatedSupabaseTestDatabase, supabaseProjectRef };
