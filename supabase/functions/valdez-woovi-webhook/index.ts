// Webhook da Woovi: é ele que transforma dinheiro recebido em licença ativa.
// Toda a segurança da cobrança mora aqui — quem passar por esta função vira
// cliente pagante sem ter pagado.
//
// O bot não é chamado: a licença é escrita no banco e o pullLicenses do bot
// aplica em até 60s. Assim a VPS não precisa estar exposta na internet.
//
// Só a fiação Deno mora neste arquivo. A decisão está em handler.ts, que roda
// em teste.

import { createWebhookHandler, type ApplyEventArgs } from './handler.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const handle = createWebhookHandler({
  hmacSecret: Deno.env.get('WOOVI_WEBHOOK_HMAC_SECRET') ?? '',
  applyEvent: (args: ApplyEventArgs) =>
    fetch(`${SUPABASE_URL}/rest/v1/rpc/apply_woovi_event`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Profile': 'valdez',
        'Content-Profile': 'valdez',
      },
      body: JSON.stringify(args),
    }),
});

Deno.serve(handle);
