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

export interface ConfigDoInstantly {
  apiKey: string;
  campanhaInstantly: string;
  db: Db;
  /**
   * Quando e por quem a premissa das `custom_variables` foi validada contra
   * uma conta real — uma data ISO, ou uma nota curta ("2026-08-30, Thiago").
   *
   * Uma nota em markdown dizendo "ainda não validamos" é exatamente o modo de
   * falha que este projeto já diagnosticou nas guardas que ninguém chama. Aqui
   * o construtor recusa, e o primeiro envio real não acontece por acidente.
   */
  premissaValidadaEm: string;
}

export function criarProvedorInstantly(
  config: ConfigDoInstantly,
  deps: { fetch?: FetchLike } = {},
): ColdEmailProvider {
  if (!config.premissaValidadaEm?.trim()) {
    throw new Error(
      "Provedor do Instantly recusado: a premissa das custom variables não foi " +
        "validada. O produto inteiro depende de assunto e corpo por lead num " +
        "template feito só de merge tags — padrão que não está na referência da " +
        "API. Rode a Task 5, Step 1 do plano numa conta real e confira, na " +
        "mensagem recebida: os três parágrafos mantiveram as quebras de linha, " +
        "os acentos não viraram entidades HTML nem '?', nada foi truncado, e o " +
        "assunto veio da variável em vez do literal {{assunto_email}}. Só então " +
        "informe `premissaValidadaEm`.",
    );
  }

  const cabecalhos = {
    authorization: `Bearer ${config.apiKey}`,
    "content-type": "application/json",
  };

  return {
    modo: "live",

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
          // Uma tentativa só, de propósito. Criar lead não é idempotente e o
          // Instantly não documenta chave de idempotência: um POST que ele
          // processou mas respondeu com 502 seria repetido, plausivelmente
          // cadastrando o lead duas vezes e mandando o mesmo e-mail duas vezes
          // para o prospect. É o mesmo dano que já barramos na gravação, só que
          // chegando pelo caminho do retry.
          tentativas: 1,
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
        const gravada = await anexarMensagem(config.db, {
          tenantId: email.tenantId,
          leadId: email.leadId,
          direction: "outbound",
          subject: email.assunto,
          body: email.corpo,
          externalId: externalId ?? undefined,
          shadow: false,
        });

        // `null` significa conflito de `external_id`: já existe linha para
        // este envio, ou seja, esta pessoa já recebeu. Ignorar o retorno
        // deixava o `enviados` do disjuntor subcontado e a duplicata sem
        // rastro. Relatamos sucesso mesmo assim — o e-mail saiu em algum
        // momento, e relatar falha faria o lote reenviar.
        if (!gravada) {
          await registrarEvento(config.db, {
            tenantId: email.tenantId,
            leadId: email.leadId,
            kind: "envio_duplicado_ignorado",
            payload: { externalId, assunto: email.assunto },
          });
        }
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
     *
     * A campanha consultada é a do fornecedor (`config.campanhaInstantly`).
     * Hoje ela é única e global, então estes números são do workspace inteiro
     * — por isso `enviarLote` não os usa. Ficam aqui para o painel e para
     * quando cada campanha tiver o seu próprio id no fornecedor.
     */
    async contarBounces() {
      try {
        const parametros = new URLSearchParams({
          id: config.campanhaInstantly,
        });
        const resposta = await fetchJson<RespostaAnalytics[]>(
          `${BASE}/campaigns/analytics?${parametros}`,
          { fetch: deps.fetch, headers: cabecalhos, tentativas: 2 },
        );
        const linha = resposta.find(
          (r) => r.campaign_id === config.campanhaInstantly,
        );
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
