// Cria a assinatura na Woovi e devolve o link de pagamento.
//
// Chamada pelo site, pelo dono do servidor logado com Discord. O preço é
// decidido aqui: aceitar valor vindo do cliente deixaria qualquer um assinar o
// Máximo por um centavo.

const WOOVI_APP_ID = Deno.env.get('WOOVI_APP_ID') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const PRICE_CENTS: Record<string, number> = {
  basic: 1000,
  pro: 3000,
  max: 5000,
  lifetime: 15000,
};

const FOUNDER_PRICE_CENTS = 1000;

const CORS = {
  'Access-Control-Allow-Origin': Deno.env.get('SITE_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function db(path: string, init: RequestInit = {}): Promise<Response> {
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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (!WOOVI_APP_ID) return json({ error: 'gateway não configurado' }, 503);

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
  if (!jwt) return json({ error: 'não autenticado' }, 401);

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!userRes.ok) return json({ error: 'não autenticado' }, 401);
  const user = await userRes.json();

  // O Discord é o provedor: provider_id é o ID do usuário lá, que é o mesmo que
  // o bot grava em guilds.owner_id. É esse par que prova a posse do servidor.
  const discordId: string | undefined =
    user?.user_metadata?.provider_id ?? user?.user_metadata?.sub;
  if (!discordId) return json({ error: 'entre com o Discord' }, 403);

  const body = await req.json().catch(() => ({}));
  const guildId = String(body.guildId ?? '');
  const plan = String(body.plan ?? '');
  if (!guildId || !(plan in PRICE_CENTS)) return json({ error: 'pedido inválido' }, 400);

  const guildRes = await db(`guilds?guild_id=eq.${guildId}&select=guild_id,name,owner_id`);
  const [guild] = (await guildRes.json()) as any[];
  if (!guild) return json({ error: 'o bot ainda não está nesse servidor' }, 404);
  if (guild.owner_id !== discordId) return json({ error: 'só o dono do servidor assina' }, 403);

  // Vaga de fundador é decidida no servidor. Confiar num "founder: true" vindo
  // do cliente daria R$ 10 vitalício pra quem editasse o request.
  const slotsRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/founder_slots_left`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Content-Profile': 'valdez',
    },
    body: '{}',
  });
  const slotsLeft = Number(await slotsRes.json());
  const founder = plan !== 'lifetime' && slotsLeft > 0;
  const priceCents = founder ? FOUNDER_PRICE_CENTS : PRICE_CENTS[plan];

  const correlationId = `${guildId}-${plan}-${Date.now()}`;

  const insert = await db('subscriptions', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      guild_id: guildId,
      plan,
      correlation_id: correlationId,
      status: 'pending',
      price_cents: priceCents,
      founder,
    }),
  });
  if (!insert.ok) {
    console.error(`[checkout] falha ao gravar assinatura: ${await insert.text()}`);
    return json({ error: 'não consegui abrir a cobrança' }, 500);
  }

  // Vitalício é pagamento único: cobrança avulsa, não assinatura recorrente.
  const endpoint = plan === 'lifetime' ? 'charge' : 'subscriptions';
  const payload =
    plan === 'lifetime'
      ? {
          correlationID: correlationId,
          value: priceCents,
          comment: `Valdez Vitalício — ${guild.name ?? guildId}`,
        }
      : {
          customer: { name: guild.name ?? guildId, correlationID: guildId },
          value: priceCents,
          dayGenerateCharge: new Date().getDate() > 28 ? 28 : new Date().getDate(),
          correlationID: correlationId,
          comment: `Valdez ${plan} — ${guild.name ?? guildId}`,
        };

  const woovi = await fetch(`https://api.woovi.com/api/v1/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: WOOVI_APP_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!woovi.ok) {
    console.error(`[checkout] Woovi ${woovi.status}: ${await woovi.text()}`);
    return json({ error: 'o gateway recusou a cobrança' }, 502);
  }

  const data = await woovi.json();
  const charge = data.charge ?? data.subscription ?? data;

  await db(`subscriptions?correlation_id=eq.${encodeURIComponent(correlationId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ woovi_subscription_id: charge.globalID ?? charge.id ?? null }),
  });

  return json({
    paymentUrl: charge.paymentLinkUrl ?? charge.pixKey ?? null,
    brCode: charge.brCode ?? null,
    qrCodeImage: charge.qrCodeImage ?? null,
    priceCents,
    founder,
  });
});
