import fs from 'node:fs';
import path from 'node:path';
import type { UndoRecord } from '../../shared/ipcTypes';

/**
 * Persists undo records to a JSON file so "Undo last push" survives
 * app restarts. The ledger is append-only during normal operation;
 * entries are marked `undoneAt` when the restore completes.
 */
export class UndoLedger {
  private readonly filePath: string;
  private records: UndoRecord[] | undefined;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, 'cloudwayssync', 'undo-ledger.json');
  }

  async list(): Promise<UndoRecord[]> {
    if (!this.records) {
      this.records = await this.load();
    }
    return this.records;
  }

  async add(record: UndoRecord): Promise<void> {
    const records = await this.list();
    records.push(record);
    await this.save(records);
  }

  async get(recordId: string): Promise<UndoRecord | undefined> {
    const records = await this.list();
    return records.find((r) => r.id === recordId);
  }

  async markUndone(recordId: string): Promise<void> {
    const records = await this.list();
    const record = records.find((r) => r.id === recordId);
    if (record) {
      record.undoneAt = new Date().toISOString();
      await this.save(records);
    }
  }

  private async load(): Promise<UndoRecord[]> {
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async save(records: UndoRecord[]): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.promises.writeFile(this.filePath, JSON.stringify(records, null, 2) + '\n', 'utf8');
    this.records = records;
  }
}
