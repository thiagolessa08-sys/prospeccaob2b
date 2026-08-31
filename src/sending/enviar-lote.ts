import type { Db } from "../db/port.js";
import {
  buscarCampanha,
  contarEnviosEBounces,
  pausarCampanha,
} from "../db/repositories/campaigns.js";
import {
  listarProntosParaContato,
  transicionarLead,
} from "../db/repositories/leads.js";
import { carregarRegrasDeSupressao } from "../db/repositories/suppression.js";
import { registrarEvento } from "../db/repositories/events.js";
import { isSuppressed } from "../domain/suppression.js";
import { avaliarDisjuntor, AMOSTRA_MINIMA } from "../domain/bounce.js";
import { writeFirstEmail } from "../ai/email-writer.js";
import type { ColdEmailProvider } from "./types.js";

export interface ResultadoDoLote {
  enviados: number;
  suprimidos: number;
  falhas: number;
  disjuntorAberto: boolean;
  motivo: string;
}

export interface DepsDoLote {
  escreverEmail: typeof writeFirstEmail;
}

const DEPS_PADRAO: DepsDoLote = { escreverEmail: writeFirstEmail };

/**
 * O disparo diário de uma campanha.
 *
 * Função comum, não rota HTTP: escrever o e-mail de cada lead são chamadas ao
 * Claude, e um lote de 50 leva minutos. Quem agenda é o n8n, chamando a rota
 * fina que embrulha esta função (Plano 4).
 */
export async function enviarLote(
  input: {
    db: Db;
    tenantId: string;
    campaignId: string;
    provedor: ColdEmailProvider;
  },
  deps: DepsDoLote = DEPS_PADRAO,
): Promise<ResultadoDoLote> {
  const { db, tenantId, campaignId, provedor } = input;
  const vazio = { enviados: 0, suprimidos: 0, falhas: 0, disjuntorAberto: false };

  const campanha = await buscarCampanha(db, tenantId, campaignId);
  if (!campanha) {
    return { ...vazio, motivo: "Campanha não encontrada." };
  }
  if (campanha.status !== "active") {
    return {
      ...vazio,
      motivo: `Campanha não está ativa (${campanha.status}), nada a enviar.`,
    };
  }

  // O disjuntor roda antes de qualquer envio: uma campanha que já está
  // queimando reputação não deve mandar nem mais um e-mail.
  //
  // A contagem local é a única que respeita o tenant: hoje há um único
  // INSTANTLY_CAMPAIGN_ID global, então os números do fornecedor são do
  // workspace inteiro, e a lista ruim de um cliente pausaria a campanha de
  // outro. Quando cada campanha tiver seu id no fornecedor, reavaliar — a
  // reputação é medida do lado dele.
  const contagem = await contarEnviosEBounces(db, tenantId, campaignId);
  const disjuntor = avaliarDisjuntor(contagem);
  if (disjuntor.abrir) {
    await pausarCampanha(db, tenantId, campaignId, disjuntor.motivo);
    return { ...vazio, disjuntorAberto: true, motivo: disjuntor.motivo };
  }

  // Enquanto ninguém gravar `leads.bounced_at`, zero bounce numa amostra
  // grande é indistinguível de uma campanha saudável — e o disjuntor fica
  // inerte em silêncio. O evento existe para que a inércia seja barulhenta.
  if (contagem.bounces === 0 && contagem.enviados >= AMOSTRA_MINIMA) {
    await registrarEvento(db, {
      tenantId,
      leadId: null,
      kind: "disjuntor_sem_fonte_de_bounce",
      payload: {
        campaignId,
        enviados: contagem.enviados,
        aviso:
          "Nenhum bounce registrado numa amostra significativa. Enquanto o webhook do Instantly não gravar leads.bounced_at, o disjuntor não tem como abrir.",
      },
    });
  }

  const prontos = await listarProntosParaContato(
    db,
    tenantId,
    campaignId,
    campanha.daily_send_limit,
  );
  if (prontos.length === 0) {
    return { ...vazio, motivo: "Nenhum lead pronto para contato." };
  }

  const regras = await carregarRegrasDeSupressao(db, tenantId);

  let enviados = 0;
  let suprimidos = 0;
  let falhas = 0;

  for (const lead of prontos) {
    // Todo o corpo do laço é protegido. `transicionarLead` estoura por
    // desenho quando outro fluxo move o lead no mesmo instante — corrida real
    // sob `pg.Pool` e invisível sob o PGlite de uma conexão só —, e a
    // transição do fim roda DEPOIS de `provedor.enviar()` já ter colocado um
    // e-mail na frente do prospect. Deixar a exceção escapar abortaria o lote,
    // deixaria os leads seguintes sem contato e devolveria uma promessa
    // rejeitada a quem chamou, perdendo a conta do que já saiu.
    try {
      // A supressão é conferida antes de escrever o e-mail: gastar uma chamada de
      // IA para alguém que nunca vai receber é desperdício, e a checagem é grátis.
      if (isSuppressed(lead.email, regras)) {
        await transicionarLead(db, tenantId, lead.id, "discarded", {
          discardReason: "endereço suprimido",
        });
        await registrarEvento(db, {
          tenantId,
          leadId: lead.id,
          kind: "envio_bloqueado_por_supressao",
          payload: { email: lead.email },
        });
        suprimidos += 1;
        continue;
      }

      const empresa = await buscarEmpresaDoLead(db, tenantId, lead.company_id);

      let rascunho: { subject: string; body: string };
      try {
        rascunho = await deps.escreverEmail({
          voice: {
            offerDescription: campanha.offer_description,
            tone: campanha.tone,
            senderFirstName: campanha.sender_first_name,
          },
          company: {
            legalName: empresa?.legal_name ?? "",
            tradeName: empresa?.trade_name ?? null,
            summary: empresa?.summary ?? null,
            city: empresa?.city ?? null,
            uf: empresa?.uf ?? null,
          },
          lead: { fullName: lead.full_name, roleTitle: lead.role_title },
        });
      } catch (erro) {
        await registrarEvento(db, {
          tenantId,
          leadId: lead.id,
          kind: "falha_ao_escrever_email",
          payload: { erro: erro instanceof Error ? erro.message : String(erro) },
        });
        falhas += 1;
        continue;
      }

      const [primeiroNome, ...resto] = (lead.full_name ?? "").trim().split(/\s+/);
      const resultado = await provedor.enviar({
        tenantId,
        leadId: lead.id,
        email: lead.email,
        primeiroNome: primeiroNome || null,
        sobrenome: resto.length ? resto[resto.length - 1]! : null,
        empresa: empresa?.trade_name ?? empresa?.legal_name ?? null,
        site: empresa?.website ?? null,
        assunto: rascunho.subject,
        corpo: rascunho.body,
      });

      if (!resultado.enviado) {
        await registrarEvento(db, {
          tenantId,
          leadId: lead.id,
          kind: "falha_no_envio",
          payload: { motivo: resultado.motivo },
        });
        falhas += 1;
        continue;
      }

      // Em sombra o estágio não avança: o ensaio não pode consumir a fila. A
      // linha em `messages` com shadow = true é o registro do que teria saído,
      // e o lead continua elegível para o envio de verdade.
      //
      // `enriched -> contacted` é legal, `contacted -> enriched` não é, e
      // `listarProntosParaContato` só enxerga `enriched`: avançar aqui
      // queimaria a fila para sempre, e a promoção da campanha para live
      // enviaria para ninguém. Como consequência, rodar a sombra duas vezes
      // regera rascunhos para os mesmos leads — que é o certo para um ensaio.
      if (!resultado.sombra) {
        await transicionarLead(db, tenantId, lead.id, "contacted");
      }
      enviados += 1;
    } catch (erro) {
      falhas += 1;
      await registrarEvento(db, {
        tenantId,
        leadId: lead.id,
        kind: "falha_no_lote",
        payload: {
          leadId: lead.id,
          erro: erro instanceof Error ? erro.message : String(erro),
        },
      }).catch(() => {
        // Se nem o evento grava, o banco está fora e não há mais o que fazer
        // daqui. O lote segue para os leads que ainda derem para processar.
      });
    }
  }

  return {
    enviados,
    suprimidos,
    falhas,
    disjuntorAberto: false,
    motivo: `Lote concluído: ${enviados} enviado(s), ${suprimidos} suprimido(s), ${falhas} falha(s).`,
  };
}

async function buscarEmpresaDoLead(
  db: Db,
  tenantId: string,
  companyId: string,
) {
  const { rows } = await db.query<{
    legal_name: string;
    trade_name: string | null;
    summary: string | null;
    city: string | null;
    uf: string | null;
    website: string | null;
  }>(
    `select legal_name, trade_name, summary, city, uf, website
     from companies where tenant_id = $1 and id = $2`,
    [tenantId, companyId],
  );
  return rows[0] ?? null;
}
