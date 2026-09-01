import { segredoConfere } from "../assinatura.js";
import type { Db } from "../../db/port.js";
import { criarCampanha, type NovaCampanha } from "../../db/repositories/campaigns.js";
import { HEADER_SEGREDO_N8N } from "./processar-resposta.js";

export interface DepsCriarCampanhaHttp {
  db: Db;
  tenantId: string;
  segredo: string;
}

interface CorpoDaCriacao {
  name?: unknown;
  nicheDescription?: unknown;
  offerDescription?: unknown;
  schedulingLink?: unknown;
  senderFirstName?: unknown;
  solutionPurpose?: unknown;
  tone?: unknown;
  dailySendLimit?: unknown;
}

/** Caminho antigo: a pessoa escreve nicho e oferta separados. */
const CAMPOS_CLASSICOS = [
  "name",
  "nicheDescription",
  "offerDescription",
  "schedulingLink",
  "senderFirstName",
] as const;

/**
 * Caminho do painel: a pessoa escreve só o propósito da solução, e a IA
 * deriva nicho e oferta depois, em `POST /campaigns/:id/propor`.
 */
const CAMPOS_PELO_PROPOSITO = [
  "name",
  "solutionPurpose",
  "schedulingLink",
  "senderFirstName",
] as const;

function textoNaoVazio(valor: unknown): valor is string {
  return typeof valor === "string" && valor.trim().length > 0;
}

/**
 * O ponto de entrada do produto: alguém descreve o nicho em texto livre, e é
 * essa descrição — `nicheDescription` — que `gerarFiltros` lê depois para
 * transformar em CNAE/UF/cidade/cargo-alvo. Esta rota só grava a linha da
 * campanha; a leitura da descrição pela IA é a rota seguinte, de propósito,
 * para uma falha na IA não impedir a campanha de existir.
 */
export async function tratarCriarCampanha(
  req: Request,
  deps: DepsCriarCampanhaHttp,
): Promise<Response> {
  if (!segredoConfere(req.headers.get(HEADER_SEGREDO_N8N), deps.segredo)) {
    return new Response("segredo inválido", { status: 401 });
  }

  let corpo: CorpoDaCriacao;
  try {
    corpo = (await req.json()) as CorpoDaCriacao;
  } catch {
    return new Response(JSON.stringify({ erro: "corpo não é JSON válido" }), {
      status: 400,
    });
  }

  const peloProposito = textoNaoVazio(corpo.solutionPurpose);
  // Anotado, e não inferido: sem isto o tipo vira a união das duas tuplas, e
  // chamar `.filter` sobre união de tuplas com elementos diferentes é onde o
  // TypeScript desiste.
  const exigidos: readonly (keyof CorpoDaCriacao)[] = peloProposito
    ? CAMPOS_PELO_PROPOSITO
    : CAMPOS_CLASSICOS;

  const faltando = exigidos.filter((campo) => !textoNaoVazio(corpo[campo]));
  if (faltando.length > 0) {
    return new Response(
      JSON.stringify({ erro: `campo(s) obrigatório(s) ausente(s): ${faltando.join(", ")}` }),
      { status: 400 },
    );
  }

  /**
   * Pelo propósito, nicho e oferta nascem provisórios com o próprio texto do
   * propósito, e são substituídos na aprovação da proposta.
   *
   * As duas colunas são `not null` no schema desde o início, e afrouxá-las
   * espalharia `string | null` por todo o escritor de e-mail e pelo
   * `parseNiche` — que hoje podem confiar que sempre há texto. O valor
   * provisório é ruim para prospectar, mas a campanha também não prospecta
   * nada antes da proposta ser aprovada: `filters` está nulo e
   * `descobrirEmpresas` não roda sem filtro útil.
   */
  const proposito = peloProposito ? (corpo.solutionPurpose as string) : null;

  const input: NovaCampanha = {
    tenantId: deps.tenantId,
    name: corpo.name as string,
    nicheDescription: textoNaoVazio(corpo.nicheDescription)
      ? corpo.nicheDescription
      : proposito!,
    offerDescription: textoNaoVazio(corpo.offerDescription)
      ? corpo.offerDescription
      : proposito!,
    solutionPurpose: proposito ?? undefined,
    schedulingLink: corpo.schedulingLink as string,
    senderFirstName: corpo.senderFirstName as string,
    tone: textoNaoVazio(corpo.tone) ? corpo.tone : undefined,
    dailySendLimit:
      typeof corpo.dailySendLimit === "number" ? corpo.dailySendLimit : undefined,
  };

  const campanha = await criarCampanha(deps.db, input);
  return new Response(JSON.stringify(campanha), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}
