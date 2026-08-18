// Webhook da Woovi: é ele que transforma dinheiro recebido em licença ativa.
// Toda a segurança da cobrança mora aqui — quem passar por esta função vira
// cliente pagante sem ter pagado.
//
// O bot não é chamado: a licença é escrita no banco e o pullLicenses do bot
// aplica em até 60s. Assim a VPS não precisa estar exposta na internet.

const HMAC_SECRET = Deno.env.get('WOOVI_WEBHOOK_HMAC_SECRET') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const PAID_EVENTS = new Set([
  'OPENPIX:CHARGE_COMPLETED',
  'OPENPIX:TRANSACTION_RECEIVED',
  'OPENPIX:MOVEMENT_CONFIRMED',
]);

const CANCEL_EVENTS = new Set([
  'OPENPIX:SUBSCRIPTION_CANCELED',
  'OPENPIX:CHARGE_EXPIRED',
]);

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A Woovi migrou a assinatura de RSA pra HMAC e quem só validava RSA passou a
// devolver 401 em toda confirmação — pagamento entrava e a licença nunca ligava.
// O secret do painel é usado inteiro como chave, digest em base64.
async function validSignature(rawBody: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(HMAC_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return timingSafeEqual(expected, signature);
}

async function db(path: string, init: RequestInit): Promise<Response> {
  return await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Accept-Profile': 'valdez',
      'Content-Profile': 'valdez',
      ...(init.headers ?? {}),
    },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  // Sem secret configurado a função não "libera geral": ela se recusa a rodar.
  // Deixar passar quando a validação não é possível foi exatamente o atalho que
  // já custou pagamento perdido em produção.
  if (!HMAC_SECRET) {
    console.error('[woovi] WOOVI_WEBHOOK_HMAC_SECRET ausente — recusando');
    return new Response('webhook not configured', { status: 503 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get('x-webhook-signature') ?? '';
  if (!signature || !(await validSignature(rawBody, signature))) {
    return new Response('invalid signature', { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('invalid json', { status: 400 });
  }

  const event: string = payload.event ?? '';
  const charge = payload.charge ?? payload.payment ?? payload.subscription ?? {};
  const correlationId: string | undefined = charge.correlationID ?? payload.correlationID;

  if (!correlationId) return new Response('ok (sem correlationID)', { status: 200 });

  // A Woovi reentrega o mesmo evento até receber 200. Sem trava, uma reentrega
  // somaria mais um mês de licença sem ninguém pagar por ele.
  const eventId = `${event}:${charge.endToEndId ?? charge.transactionID ?? correlationId}`;
  const seen = await db('webhook_events', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ provider_event_id: eventId }),
  });
  if (seen.status === 409) return new Response('ok (duplicado)', { status: 200 });

  const subRes = await db(
    `subscriptions?correlation_id=eq.${encodeURIComponent(correlationId)}&select=*`,
    { method: 'GET' }
  );
  const [sub] = (await subRes.json()) as any[];
  if (!sub) {
    console.warn(`[woovi] correlationID sem assinatura: ${correlationId}`);
    return new Response('ok (assinatura desconhecida)', { status: 200 });
  }

  if (CANCEL_EVENTS.has(event)) {
    await db(`subscriptions?id=eq.${sub.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'canceled', updated_at: new Date().toISOString() }),
    });
    // A licença não é derrubada aqui: o cliente pagou o mês corrente e usa até
    // o expires_at. É o próprio vencimento que devolve o servidor pro grátis.
    return new Response('ok (cancelado)', { status: 200 });
  }

  if (!PAID_EVENTS.has(event)) return new Response('ok (evento ignorado)', { status: 200 });

  const now = new Date();
  const expiresAt =
    sub.plan === 'lifetime'
      ? null
      : new Date(now.getTime() + 31 * 86400_000).toISOString();

  await db('licenses?on_conflict=guild_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      guild_id: sub.guild_id,
      plan: sub.plan,
      status: 'active',
      price_cents: sub.price_cents,
      founder: sub.founder,
      started_at: now.toISOString(),
      expires_at: expiresAt,
      external_ref: correlationId,
      updated_at: now.toISOString(),
    }),
  });

  await db('payments', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      guild_id: sub.guild_id,
      amount_cents: sub.price_cents,
      method: 'woovi',
      external_ref: correlationId,
      paid_at: now.toISOString(),
    }),
  });

  await db(`subscriptions?id=eq.${sub.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'active', updated_at: now.toISOString() }),
  });

  console.log(`[woovi] ${sub.guild_id}: ${sub.plan} ativo até ${expiresAt ?? 'sempre'}`);
  return new Response('ok', { status: 200 });
});
