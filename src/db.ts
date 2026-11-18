import pg from "pg";

// Default = the database from docker-compose.yml. Set DATABASE_URL to use another one.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://roll:roll@localhost:5433/property_roll",
});
