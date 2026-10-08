// Núcleo do webhook da Woovi, sem nada de Deno: é ele que transforma dinheiro
// recebido em licença ativa, então precisa rodar em teste.
//
// Regra que governa este arquivo: nunca devolver 200 por trabalho que não foi
// feito. A Woovi só reentrega quando não recebe 2xx — um 200 otimista é um
// pagamento perdido em silêncio.

export const LICENSE_PERIOD_DAYS = 31;

export type WebhookOutcome = 'duplicate' | 'unknown_subscription' | 'canceled' | 'paid';

export interface WebhookDeps {
  hmacSecret: string;
  applyEvent: (args: ApplyEventArgs) => Promise<Response>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface ApplyEventArgs {
  p_event_id: string;
  p_correlation_id: string;
  p_kind: 'paid' | 'canceled';
  p_expires_at: string;
  p_now: string;
}

const PAID_EVENTS = new Set([
  'OPENPIX:CHARGE_COMPLETED',
  'OPENPIX:TRANSACTION_RECEIVED',
  'OPENPIX:MOVEMENT_CONFIRMED',
]);

const CANCEL_EVENTS = new Set(['OPENPIX:SUBSCRIPTION_CANCELED', 'OPENPIX:CHARGE_EXPIRED']);

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A Woovi migrou a assinatura de RSA pra HMAC e quem só validava RSA passou a
// devolver 401 em toda confirmação — pagamento entrava e a licença nunca ligava.
// O secret do painel é usado inteiro como chave, digest em base64.
export async function signBody(secret: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

function classify(event: string): 'paid' | 'canceled' | null {
  if (PAID_EVENTS.has(event)) return 'paid';
  if (CANCEL_EVENTS.has(event)) return 'canceled';
  return null;
}

export function createWebhookHandler(deps: WebhookDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((message: string) => console.log(message));

  return async function handle(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

    // Sem secret configurado a função não "libera geral": ela se recusa a rodar.
    // Deixar passar quando a validação não é possível foi exatamente o atalho que
    // já custou pagamento perdido em produção.
    if (!deps.hmacSecret) {
      log('[woovi] WOOVI_WEBHOOK_HMAC_SECRET ausente — recusando');
      return new Response('webhook not configured', { status: 503 });
    }

    const rawBody = await req.text();
    const signature = req.headers.get('x-webhook-signature') ?? '';
    const expected = await signBody(deps.hmacSecret, rawBody);
    if (!signature || !timingSafeEqual(expected, signature)) {
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

    const kind = classify(event);
    if (!kind) return new Response('ok (evento ignorado)', { status: 200 });

    const at = now();
    // endToEndId distingue uma renovação da anterior: sem ele, o segundo mês da
    // mesma assinatura seria descartado como duplicata e ninguém receberia.
    const eventId = `${event}:${charge.endToEndId ?? charge.transactionID ?? correlationId}`;

    let res: Response;
    try {
      res = await deps.applyEvent({
        p_event_id: eventId,
        p_correlation_id: correlationId,
        p_kind: kind,
        p_expires_at: new Date(at.getTime() + LICENSE_PERIOD_DAYS * 86400_000).toISOString(),
        p_now: at.toISOString(),
      });
    } catch (err: any) {
      log(`[woovi] erro chamando apply_woovi_event (${correlationId}): ${err?.message}`);
      return new Response('erro ao aplicar evento', { status: 500 });
    }

    if (!res.ok) {
      // 5xx de propósito: a Woovi reentrega e a trava não ficou gravada, porque
      // ela comita junto com a licença ou não comita.
      log(`[woovi] apply_woovi_event falhou (${correlationId}): ${res.status} ${await res.text()}`);
      return new Response('erro ao aplicar evento', { status: 500 });
    }

    const outcome = parseOutcome(await res.text());
    if (!outcome) {
      log(`[woovi] resposta inesperada de apply_woovi_event (${correlationId})`);
      return new Response('erro ao aplicar evento', { status: 500 });
    }

    if (outcome === 'unknown_subscription') {
      log(`[woovi] correlationID sem assinatura: ${correlationId}`);
    } else {
      log(`[woovi] ${correlationId}: ${outcome}`);
    }
    return new Response(`ok (${outcome})`, { status: 200 });
  };
}

function parseOutcome(body: string): WebhookOutcome | null {
  let value = body.trim();
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'string') value = parsed;
  } catch {
    // PostgREST devolve o texto cru quando o Accept não é JSON.
  }
  return value === 'duplicate' ||
    value === 'unknown_subscription' ||
    value === 'canceled' ||
    value === 'paid'
    ? value
    : null;
}
