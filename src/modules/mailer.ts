import { config } from '../config';
import { logger } from '../utils/logger';

// Sem domínio verificado a Resend só entrega de `onboarding@resend.dev` e só
// para o email dono da conta. Serve exatamente pro /feedback, que vai pra uma
// caixa só. Trocar por remetente próprio depois exige verificar o domínio.
const FROM = 'Valdez <onboarding@resend.dev>';

interface Feedback {
  guildName: string | null;
  username: string;
  rating: number | null;
  message: string;
  canPublish: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function mailerEnabled(): boolean {
  return !!config.resendApiKey && !!config.feedbackEmailTo;
}

// Fire-and-forget: o Discord derruba a interação em 3s e o feedback já está no
// SQLite antes daqui. Email que falha não pode custar a resposta ao usuário.
export function sendFeedbackEmail(feedback: Feedback): void {
  if (!mailerEnabled()) return;

  const stars = feedback.rating ? '⭐'.repeat(feedback.rating) : 'sem nota';
  const subject = `[Valdez] ${feedback.username} — ${stars}`;
  const html = [
    `<p><strong>Servidor:</strong> ${escapeHtml(feedback.guildName ?? 'desconhecido')}</p>`,
    `<p><strong>Quem escreveu:</strong> ${escapeHtml(feedback.username)}</p>`,
    `<p><strong>Nota:</strong> ${stars}</p>`,
    `<hr><p>${escapeHtml(feedback.message).replace(/\n/g, '<br>')}</p><hr>`,
    feedback.canPublish
      ? '<p>✅ Liberou publicar no site. Aprove no painel pra ir pro ar.</p>'
      : '<p>🔒 Não liberou publicar no site.</p>',
  ].join('');

  void fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to: [config.feedbackEmailTo], subject, html }),
    signal: AbortSignal.timeout(10_000),
  })
    .then(async (res) => {
      if (!res.ok) logger.warn(`[MAIL] Resend respondeu ${res.status}: ${await res.text()}`);
    })
    .catch((err: any) => logger.warn(`[MAIL] falha ao enviar feedback: ${err?.message}`));
}
