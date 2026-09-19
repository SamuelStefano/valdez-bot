import { describe, expect, it, vi } from 'vitest';
import { createWebhookHandler, signBody, type ApplyEventArgs } from './handler.ts';

const SECRET = 'woovi-test-secret';
const NOW = new Date('2026-09-19T12:00:00.000Z');

const paidPayload = {
  event: 'OPENPIX:CHARGE_COMPLETED',
  charge: { correlationID: 'valdez-guild-1-abc', endToEndId: 'E2E-1' },
};

function rpcResponse(outcome: string, status = 200): Response {
  return new Response(JSON.stringify(outcome), { status });
}

async function signedRequest(payload: unknown, secret = SECRET): Promise<Request> {
  const body = JSON.stringify(payload);
  return new Request('https://edge.test/valdez-woovi-webhook', {
    method: 'POST',
    headers: { 'x-webhook-signature': await signBody(secret, body) },
    body,
  });
}

function build(applyEvent: (args: ApplyEventArgs) => Promise<Response>, hmacSecret = SECRET) {
  return createWebhookHandler({ hmacSecret, applyEvent, now: () => NOW, log: () => {} });
}

describe('valdez-woovi-webhook', () => {
  it('refuses a non-POST request', async () => {
    const applyEvent = vi.fn();
    const res = await build(applyEvent)(new Request('https://edge.test', { method: 'GET' }));
    expect(res.status).toBe(405);
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it('fails closed when the HMAC secret is missing', async () => {
    const applyEvent = vi.fn();
    const res = await build(applyEvent, '')(await signedRequest(paidPayload));
    expect(res.status).toBe(503);
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it('rejects a wrong signature without touching the database', async () => {
    const applyEvent = vi.fn();
    const res = await build(applyEvent)(await signedRequest(paidPayload, 'other-secret'));
    expect(res.status).toBe(401);
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it('rejects a missing signature', async () => {
    const applyEvent = vi.fn();
    const body = JSON.stringify(paidPayload);
    const res = await build(applyEvent)(
      new Request('https://edge.test', { method: 'POST', body })
    );
    expect(res.status).toBe(401);
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it('accepts and ignores an event it does not handle', async () => {
    const applyEvent = vi.fn();
    const res = await build(applyEvent)(
      await signedRequest({ event: 'OPENPIX:CHARGE_CREATED', charge: { correlationID: 'x' } })
    );
    expect(res.status).toBe(200);
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it('accepts a payload without correlationID without writing', async () => {
    const applyEvent = vi.fn();
    const res = await build(applyEvent)(await signedRequest({ event: 'OPENPIX:CHARGE_COMPLETED' }));
    expect(res.status).toBe(200);
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it('applies a paid event in a single atomic call', async () => {
    const applyEvent = vi.fn().mockResolvedValue(rpcResponse('paid'));
    const res = await build(applyEvent)(await signedRequest(paidPayload));

    expect(res.status).toBe(200);
    expect(applyEvent).toHaveBeenCalledTimes(1);
    expect(applyEvent.mock.calls[0][0]).toEqual({
      p_event_id: 'OPENPIX:CHARGE_COMPLETED:E2E-1',
      p_correlation_id: 'valdez-guild-1-abc',
      p_kind: 'paid',
      p_expires_at: new Date(NOW.getTime() + 31 * 86400_000).toISOString(),
      p_now: NOW.toISOString(),
    });
  });

  it('sends a cancellation as its own kind', async () => {
    const applyEvent = vi.fn().mockResolvedValue(rpcResponse('canceled'));
    const res = await build(applyEvent)(
      await signedRequest({
        event: 'OPENPIX:SUBSCRIPTION_CANCELED',
        subscription: { correlationID: 'valdez-guild-1-abc' },
      })
    );
    expect(res.status).toBe(200);
    expect(applyEvent.mock.calls[0][0].p_kind).toBe('canceled');
  });

  // O bug que travava a venda: a licença não gravava e a função devolvia 200,
  // então a Woovi nunca reentregava e o cliente pagava sem receber.
  it('returns 5xx when the write fails so Woovi retries', async () => {
    const applyEvent = vi.fn().mockResolvedValue(new Response('boom', { status: 503 }));
    const res = await build(applyEvent)(await signedRequest(paidPayload));
    expect(res.status).toBe(500);
  });

  it('returns 5xx when the database call throws', async () => {
    const applyEvent = vi.fn().mockRejectedValue(new Error('network down'));
    const res = await build(applyEvent)(await signedRequest(paidPayload));
    expect(res.status).toBe(500);
  });

  it('returns 5xx on an unrecognized outcome instead of swallowing it', async () => {
    const applyEvent = vi.fn().mockResolvedValue(rpcResponse('something-else'));
    const res = await build(applyEvent)(await signedRequest(paidPayload));
    expect(res.status).toBe(500);
  });

  it('acknowledges a redelivery reported as duplicate', async () => {
    const applyEvent = vi.fn().mockResolvedValue(rpcResponse('duplicate'));
    const res = await build(applyEvent)(await signedRequest(paidPayload));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('duplicate');
  });

  it('acknowledges an unknown subscription so Woovi stops retrying', async () => {
    const applyEvent = vi.fn().mockResolvedValue(rpcResponse('unknown_subscription'));
    const res = await build(applyEvent)(await signedRequest(paidPayload));
    expect(res.status).toBe(200);
  });

  // Duas entregas do mesmo evento em paralelo: a função do banco serializa na PK
  // de webhook_events, então só uma delas aplica o pagamento e as duas fecham 200.
  it('applies once under concurrent duplicate deliveries', async () => {
    const claimed = new Set<string>();
    const applyEvent = vi.fn(async (args: ApplyEventArgs) => {
      if (claimed.has(args.p_event_id)) return rpcResponse('duplicate');
      claimed.add(args.p_event_id);
      return rpcResponse('paid');
    });
    const handle = build(applyEvent);

    const results = await Promise.all([
      handle(await signedRequest(paidPayload)),
      handle(await signedRequest(paidPayload)),
      handle(await signedRequest(paidPayload)),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const outcomes = await Promise.all(results.map((r) => r.text()));
    expect(outcomes.filter((o) => o.includes('paid'))).toHaveLength(1);
  });

  // Renovação do mês seguinte é um endToEndId novo: tem que passar, senão a
  // segunda cobrança some.
  it('treats a later charge of the same subscription as a new event', async () => {
    const applyEvent = vi.fn(async () => rpcResponse('paid'));
    const handle = build(applyEvent);
    await handle(await signedRequest(paidPayload));
    await handle(
      await signedRequest({
        event: 'OPENPIX:CHARGE_COMPLETED',
        charge: { correlationID: 'valdez-guild-1-abc', endToEndId: 'E2E-2' },
      })
    );
    const ids = applyEvent.mock.calls.map((c: [ApplyEventArgs]) => c[0].p_event_id);
    expect(new Set(ids).size).toBe(2);
  });
});
