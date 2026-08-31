/**
 * Teste de contrato contra o Instantly de verdade. Pulado por padrão.
 *
 *   LIVE_API=1 INSTANTLY_API_KEY=... INSTANTLY_CAMPAIGN_ID=... npm test
 *   LIVE_API=1 INSTANTLY_API_KEY=... INSTANTLY_CAMPAIGN_ID=... \
 *     npx vitest run tests/sending/instantly.live.test.ts
 *
 * Sem `LIVE_API`, ou sem qualquer uma das duas variáveis, o arquivo inteiro é
 * pulado e nenhuma chamada de rede acontece.
 *
 * Por que existe: o produto inteiro depende de entregar assunto e corpo por
 * lead através de `custom_variables`, num template feito só de merge tags. Esse
 * padrão **não está na referência da API do Instantly** e nunca foi exercido
 * contra uma conta real. Toda a suíte de mocks repete a suposição em vez de
 * checá-la — foi assim que o `user-agent` da BrasilAPI passou despercebido até
 * o primeiro teste ao vivo.
 *
 * O que ele cobre e o que não cobre: aqui se verifica que as variáveis fazem a
 * ida e a volta pela API sem mutilação — acentos intactos, três parágrafos com
 * as quebras de linha preservadas, nada truncado. O que ele **não** cobre é o
 * que o destinatário lê na caixa de entrada: se o motor de template do
 * Instantly de fato substitui `{{assunto_email}}` e `{{corpo_email}}` no
 * disparo. Isso continua exigindo a validação manual da Task 5, Step 1 —
 * disparar para um endereço seu e ler a mensagem.
 *
 * Custo: cria um lead de verdade na campanha configurada. Use uma campanha de
 * teste, com o endereço abaixo, nunca a de produção.
 */
import { describe, it, expect } from "vitest";
import { fetchJson } from "../../src/http/fetch-json.js";

const CHAVE = process.env.INSTANTLY_API_KEY;
const CAMPANHA = process.env.INSTANTLY_CAMPAIGN_ID;
const LIGADO = Boolean(process.env.LIVE_API && CHAVE && CAMPANHA);

const BASE = "https://api.instantly.ai/api/v2";

/** Endereço descartável do próprio teste. Um por execução, para não colidir. */
const DESTINATARIO = `contrato+${Date.now()}@exemplo-de-teste.invalid`;

const ASSUNTO = "Integração de dados na São João Alimentícia";

/** Três parágrafos, acentuação farta e cedilha — o pior caso realista. */
const CORPO = [
  "Olá João, tudo bem?",
  "Vi que a São João Alimentícia cresceu para três unidades em Santa Catarina. " +
    "Normalmente é aí que a consolidação de relatórios começa a doer: cada " +
    "unidade fecha o mês na sua própria planilha.",
  "Faz sentido conversarmos vinte minutos? Se não for a hora, é só ignorar.",
].join("\n\n");

describe.skipIf(!LIGADO)("Instantly — contrato ao vivo das custom variables", () => {
  it(
    "devolve assunto e corpo sem mutilar acentos nem quebras de linha",
    async () => {
      const cabecalhos = {
        authorization: `Bearer ${CHAVE}`,
        "content-type": "application/json",
      };

      const criado = await fetchJson<{ id?: string }>(`${BASE}/leads`, {
        metodo: "POST",
        headers: cabecalhos,
        corpo: JSON.stringify({
          campaign: CAMPANHA,
          email: DESTINATARIO,
          first_name: "João",
          last_name: "Gonçalves",
          company_name: "São João Alimentícia",
          custom_variables: {
            assunto_email: ASSUNTO,
            corpo_email: CORPO,
          },
        }),
        tentativas: 1,
      });

      expect(criado.id).toBeTruthy();

      const relido = await fetchJson<{
        custom_variables?: Record<string, string>;
      }>(`${BASE}/leads/${criado.id}`, { headers: cabecalhos, tentativas: 2 });

      const variaveis = relido.custom_variables ?? {};

      // A asserção que justifica o teste: se o Instantly escapar acentos como
      // entidades HTML, trocar por '?' ou comer as linhas em branco, o e-mail
      // que o prospect recebe chega ilegível — e nenhum mock pegaria isso.
      expect(variaveis.assunto_email).toBe(ASSUNTO);
      expect(variaveis.corpo_email).toBe(CORPO);

      // Explicitando o que "ida e volta sem mutilação" quer dizer, para o dia
      // em que a igualdade acima quebrar e for preciso saber por quê.
      expect(variaveis.corpo_email?.split("\n\n")).toHaveLength(3);
      expect(variaveis.corpo_email).toContain("São João Alimentícia");
      expect(variaveis.corpo_email).not.toContain("&");
    },
    60_000,
  );
});
