import type { Pool } from 'pg';

export interface PurchaseRow {
  id: string;
  sale_id: string;
  user_id: string;
  created_at: Date;
}

export class PurchasesRepo {
  constructor(private readonly db: Pool) {}

  async findByUser(saleId: string, userId: string): Promise<PurchaseRow | null> {
    const { rows } = await this.db.query<PurchaseRow>(
      'SELECT * FROM purchases WHERE sale_id = $1 AND user_id = $2',
      [saleId, userId],
    );
    return rows[0] ?? null;
  }
}