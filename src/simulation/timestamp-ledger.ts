/**
 * Timestamp event ledger — append-only JSONL log of every timestamped
 * event during the simulation. Used for post-import timestamp restoration
 * when writing to Atlassian APIs (which overwrite timestamps with server time).
 *
 * Each line is a self-contained JSON object. The file is append-safe for
 * simulation resumption — resuming from day 50 simply continues appending.
 */

import { appendFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import type { LedgerEvent } from "../types/ledger.js";

const LEDGER_FILENAME = "timestamp-ledger.jsonl";

export class TimestampLedger {
  private filePath: string;

  constructor(outputDir: string) {
    this.filePath = join(outputDir, LEDGER_FILENAME);
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
  }

  async record(event: LedgerEvent): Promise<void> {
    const line = JSON.stringify(event) + "\n";
    await appendFile(this.filePath, line, "utf-8");
  }
}
