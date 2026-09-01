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
  tone?: unknown;
  dailySendLimit?: unknown;
}

const CAMPOS_OBRIGATORIOS = [
  "name",
  "nicheDescription",
  "offerDescription",
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

  const faltando = CAMPOS_OBRIGATORIOS.filter((campo) => !textoNaoVazio(corpo[campo]));
  if (faltando.length > 0) {
    return new Response(
      JSON.stringify({ erro: `campo(s) obrigatório(s) ausente(s): ${faltando.join(", ")}` }),
      { status: 400 },
    );
  }

  const input: NovaCampanha = {
    tenantId: deps.tenantId,
    name: corpo.name as string,
    nicheDescription: corpo.nicheDescription as string,
    offerDescription: corpo.offerDescription as string,
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
