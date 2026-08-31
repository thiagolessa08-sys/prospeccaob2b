import { fetchJson, type FetchLike } from "../http/fetch-json.js";
import type { Db } from "../db/port.js";
import { anexarMensagem } from "../db/repositories/messages.js";
import { registrarEvento } from "../db/repositories/events.js";
import type {
  ColdEmailProvider,
  EmailParaEnviar,
  ResultadoDoEnvio,
} from "./types.js";

const BASE = "https://api.instantly.ai/api/v2";

/**
 * As duas variáveis que carregam o e-mail escrito pela IA.
 *
 * O Instantly define assunto e corpo no template da sequência, não por lead.
 * O contorno é deixar o template consistindo apenas destas duas tags —
 * `subject: {{assunto_email}}`, `body: {{corpo_email}}` — e mandar o texto de
 * cada lead aqui. O padrão não está na referência da API; veja a validação
 * manual na Task 5 do plano antes do primeiro envio real.
 */
const VAR_ASSUNTO = "assunto_email";
const VAR_CORPO = "corpo_email";

interface RespostaAnalytics {
  campaign_id: string;
  emails_sent_count?: number;
  bounced_count?: number;
}

export function criarProvedorInstantly(
  config: { apiKey: string; campanhaInstantly: string; db: Db },
  deps: { fetch?: FetchLike } = {},
): ColdEmailProvider {
  const cabecalhos = {
    authorization: `Bearer ${config.apiKey}`,
    "content-type": "application/json",
  };

  return {
    async enviar(email: EmailParaEnviar): Promise<ResultadoDoEnvio> {
      // Campos nulos são omitidos: o Instantly aceita ausência, e mandar null
      // explícito sobrescreveria dado que ele já tenha do lead.
      const corpo: Record<string, unknown> = {
        campaign: config.campanhaInstantly,
        email: email.email,
        custom_variables: {
          [VAR_ASSUNTO]: email.assunto,
          [VAR_CORPO]: email.corpo,
        },
      };
      if (email.primeiroNome) corpo.first_name = email.primeiroNome;
      if (email.sobrenome) corpo.last_name = email.sobrenome;
      if (email.empresa) corpo.company_name = email.empresa;
      if (email.site) corpo.website = email.site;

      let externalId: string | null = null;
      try {
        const resposta = await fetchJson<{ id?: string }>(`${BASE}/leads`, {
          fetch: deps.fetch,
          metodo: "POST",
          headers: cabecalhos,
          corpo: JSON.stringify(corpo),
          tentativas: 3,
        });
        externalId = resposta.id ?? null;
      } catch (erro) {
        return {
          enviado: false,
          motivo: erro instanceof Error ? erro.message : String(erro),
        };
      }

      // Só grava depois do sucesso: uma mensagem gravada é uma mensagem que o
      // lead recebeu, e o disjuntor conta em cima disso.
      //
      // A gravação é protegida porque o e-mail JÁ saiu. Deixar a exceção
      // escapar abortaria o lote inteiro; devolver falha faria o lote reenviar,
      // e o prospect receberia a mesma mensagem duas vezes. Registramos a
      // inconsistência para conciliação e relatamos sucesso — porque foi o que
      // de fato aconteceu.
      try {
        await anexarMensagem(config.db, {
          tenantId: email.tenantId,
          leadId: email.leadId,
          direction: "outbound",
          subject: email.assunto,
          body: email.corpo,
          externalId: externalId ?? undefined,
          shadow: false,
        });
      } catch (erro) {
        await registrarEvento(config.db, {
          tenantId: email.tenantId,
          leadId: email.leadId,
          kind: "envio_sem_registro",
          payload: {
            externalId,
            assunto: email.assunto,
            corpo: email.corpo,
            erro: erro instanceof Error ? erro.message : String(erro),
          },
        }).catch(() => {
          // Se nem o evento grava, o banco está fora e não há mais o que
          // fazer daqui. O lote segue: um e-mail já entregue não deve
          // derrubar os outros quarenta e nove.
        });
      }

      return { enviado: true, externalId, sombra: false };
    },

    /**
     * Devolve `null` em qualquer falha em vez de lançar: o disjuntor não pode
     * ser derrubado por uma indisponibilidade da analytics — ele simplesmente
     * não avalia neste ciclo.
     */
    async contarBounces(campaignId: string) {
      try {
        const parametros = new URLSearchParams({ id: campaignId });
        const resposta = await fetchJson<RespostaAnalytics[]>(
          `${BASE}/campaigns/analytics?${parametros}`,
          { fetch: deps.fetch, headers: cabecalhos, tentativas: 2 },
        );
        const linha = resposta.find((r) => r.campaign_id === campaignId);
        if (!linha) return null;
        return {
          enviados: linha.emails_sent_count ?? 0,
          bounces: linha.bounced_count ?? 0,
        };
      } catch {
        return null;
      }
    },
  };
}
