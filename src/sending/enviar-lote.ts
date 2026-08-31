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
import { avaliarDisjuntor } from "../domain/bounce.js";
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
  const doProvedor = await provedor.contarBounces(campaignId);
  const contagem = doProvedor ?? (await contarEnviosEBounces(db, tenantId, campaignId));
  const disjuntor = avaliarDisjuntor(contagem);
  if (disjuntor.abrir) {
    await pausarCampanha(db, tenantId, campaignId, disjuntor.motivo);
    return { ...vazio, disjuntorAberto: true, motivo: disjuntor.motivo };
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

    await transicionarLead(db, tenantId, lead.id, "contacted");
    enviados += 1;
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
