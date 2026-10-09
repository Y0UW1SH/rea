import { DatabaseSync } from "node:sqlite";
import { expect, it, onTestFinished } from "vitest";
import { inspectSqliteDatabaseSnapshot } from "../../../src/sqlite/SqliteDatabaseInspection.js";
import { SqliteInspectionFailure } from "../../../src/sqlite/SqliteDatabaseLimits.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

const createDatabase = async (sql: string): Promise<string> => {
  const workspace = await createTestWorkspace("rea-sqlite-expansion-");
  onTestFinished(() => removeTestWorkspace(workspace.root));
  const path = workspace.path("private.db");
  const producer = new DatabaseSync(path);
  try {
    producer.exec(sql);
  } finally {
    producer.close();
  }
  return path;
};

it("rejects an oversized generated cell through SQLite's native value limit", async () => {
  const path = await createDatabase(`
    CREATE TABLE records (
      id INTEGER,
      payload BLOB GENERATED ALWAYS AS (zeroblob(72 * 1024 * 1024)) VIRTUAL
    );
    INSERT INTO records(id) VALUES (1);
  `);
  try {
    inspectSqliteDatabaseSnapshot(path, {
      path,
      table: "records",
      row_limit: 1,
    });
    throw new Error("An oversized generated cell must not be projected");
  } catch (cause: unknown) {
    expect(cause).toMatchObject({
      code: "ERR_SQLITE_ERROR",
      errcode: 18,
    });
  }
});

it("reports additional rows without expanding an unselected generated cell", async () => {
  const path = await createDatabase(`
    CREATE TABLE records (
      id INTEGER,
      payload BLOB GENERATED ALWAYS AS (
        CASE WHEN id = 2 THEN zeroblob(72 * 1024 * 1024) ELSE X'01' END
      ) VIRTUAL
    );
    INSERT INTO records(id) VALUES (1), (2);
  `);
  const result = inspectSqliteDatabaseSnapshot(path, {
    path,
    table: "records",
    row_limit: 1,
  });
  expect(result.rows).toMatchObject({
    columns: ["id", "payload"],
    values: [
      [
        { type: "integer", value: "1" },
        { type: "blob", hex: "01" },
      ],
    ],
    returned_rows: 1,
    truncated: true,
  });
});

it("rejects the combined representation of individually small generated cells", async () => {
  const columns = Array.from(
    { length: 6 },
    (_, index) =>
      `payload_${String(index)} BLOB GENERATED ALWAYS AS (zeroblob(2 * 1024 * 1024)) VIRTUAL`,
  );
  const path = await createDatabase(`
    CREATE TABLE records (id INTEGER, ${columns.join(", ")});
    INSERT INTO records(id) VALUES (1);
  `);
  try {
    inspectSqliteDatabaseSnapshot(path, {
      path,
      table: "records",
      row_limit: 1,
    });
    throw new Error(
      "Aggregate row expansion must be rejected before projection",
    );
  } catch (cause: unknown) {
    expect(cause).toBeInstanceOf(SqliteInspectionFailure);
    expect(cause).toMatchObject({ reason: "output-limit" });
  }
});
