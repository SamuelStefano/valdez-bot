import { describe, expect, it } from 'vitest';
import { buildExpireLicensesRequest } from './licenseExpiry';

const NOW = new Date('2026-09-19T12:00:00.000Z');

describe('buildExpireLicensesRequest', () => {
  it('patches instead of upserting, so it cannot recreate a row', () => {
    expect(buildExpireLicensesRequest(NOW).method).toBe('PATCH');
  });

  it('only touches rows still marked active', () => {
    expect(buildExpireLicensesRequest(NOW).path).toContain('status=eq.active');
  });

  // A guarda que substitui o `ignore-duplicates`: uma renovação aprovada tem
  // vencimento no futuro, então o UPDATE não a alcança e o pagamento não é
  // desfeito pelo tick seguinte do sync.
  it('only touches rows whose expiry is already in the past', () => {
    const { path } = buildExpireLicensesRequest(NOW);
    expect(path).toContain(`expires_at=lt.${encodeURIComponent(NOW.toISOString())}`);
  });

  it('writes the expired status and stamps updated_at with the same instant', () => {
    const { body } = buildExpireLicensesRequest(NOW);
    expect(JSON.parse(body)).toEqual({
      status: 'expired',
      updated_at: NOW.toISOString(),
    });
  });

  it('never sends plan, price or founder, so it cannot rewrite a paid license', () => {
    const body = JSON.parse(buildExpireLicensesRequest(NOW).body) as Record<string, unknown>;
    for (const field of ['plan', 'price_cents', 'founder', 'expires_at', 'started_at']) {
      expect(body).not.toHaveProperty(field);
    }
  });
});
