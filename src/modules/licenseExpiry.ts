// O vencimento da licença era aplicado só no SQLite do bot, e o push usava
// `ignore-duplicates`, então o `status='expired'` nunca chegava no Supabase.
// Não existe job de expiração lá: a linha ficava `active` pra sempre com um
// expires_at no passado, e o painel somava no MRR quem já tinha cancelado.
//
// O conserto roda onde o painel lê. O filtro `expires_at=lt.<agora>` é o que
// torna isto seguro: uma renovação recém-aprovada tem vencimento no futuro, por
// isso o UPDATE não a alcança. Foi justamente esse atropelo (o bot subindo a
// linha local vencida por cima do pagamento aprovado) que obrigou o
// `ignore-duplicates` no push — aqui a guarda é do lado do banco, não do estado
// local, então a corrida não existe.
//
// Vitalício e o plano `owner` têm expires_at nulo e `lt` não alcança nulo, então
// ficam de fora sem precisar de exceção.

export interface ExpireLicensesRequest {
  path: string;
  method: 'PATCH';
  body: string;
}

export function buildExpireLicensesRequest(now: Date): ExpireLicensesRequest {
  const at = now.toISOString();
  return {
    path: `licenses?status=eq.active&expires_at=lt.${encodeURIComponent(at)}`,
    method: 'PATCH',
    body: JSON.stringify({ status: 'expired', updated_at: at }),
  };
}
