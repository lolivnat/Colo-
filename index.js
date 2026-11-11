import express from "express";
import pg from "pg";
import { createApp, initializeDatabase } from "./server.js";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  max: 1,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000
});

pool.on("error", (error) => console.error("Erro inesperado no pool do PostgreSQL:", error));

const app = express();
app.disable("x-powered-by");
let databaseReady;
app.use(async (_request, _response, next) => {
  try {
    databaseReady ??= initializeDatabase(pool, { serialize: true }).catch((error) => {
      databaseReady = undefined;
      throw error;
    });
    await databaseReady;
    next();
  } catch (error) {
    next(error);
  }
});
app.use(createApp(pool));

export default app;