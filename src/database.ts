import { open } from 'sqlite';
import sqlite3 from 'sqlite3';

export const database = async () => {
  const db = await open({
    filename: './database.db',
    driver: sqlite3.Database,
  });

  await db.migrate();

  return db;
};
